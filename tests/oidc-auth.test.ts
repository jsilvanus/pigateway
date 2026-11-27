import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPair, exportJWK, SignJWT, type GenerateKeyPairResult } from "jose";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  OidcVerifier,
  OIDC_GROUPS,
  DEFAULT_OIDC_ISSUER,
  DEFAULT_OIDC_CLIENT_ID,
  OidcForbiddenError
} from "../src/auth/oidc.js";
import {
  buildUiListener,
  createPinAuth,
  withOidcAuth,
  type UiRouteRule
} from "../src/ui/ui-listener.js";

async function setupKeys() {
  const { privateKey, publicKey } = (await generateKeyPair("RS256")) as GenerateKeyPairResult;
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key-1";
  publicJwk.alg = "RS256";

  const jwksMock = async () => publicKey;

  async function makeToken(claims: {
    sub?: string;
    email?: string;
    groups?: string[];
    aud?: string | string[];
    iss?: string;
    exp?: string;
  }) {
    const jwt = new SignJWT({
      email: claims.email ?? "user@example.test",
      groups: claims.groups ?? [],
      client_id: DEFAULT_OIDC_CLIENT_ID
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setSubject(claims.sub ?? "user-123")
      .setIssuer(claims.iss ?? DEFAULT_OIDC_ISSUER)
      .setAudience(claims.aud ?? "pigateway")
      .setIssuedAt();

    if (claims.exp) {
      jwt.setExpirationTime(claims.exp);
    } else {
      jwt.setExpirationTime("2h");
    }

    return jwt.sign(privateKey);
  }

  return { privateKey, publicKey, publicJwk, jwksMock, makeToken };
}

test("OidcVerifier: verifies token, resolves groups and flags correctly", async () => {
  const { jwksMock, makeToken } = await setupKeys();
  const verifier = new OidcVerifier({
    issuer: DEFAULT_OIDC_ISSUER,
    audiences: ["pigateway", "picontrol-mcp"],
    jwksOverride: jwksMock
  });

  // Admin token
  const adminToken = await makeToken({ groups: [OIDC_GROUPS.ADMIN] });
  const admin = await verifier.verify(adminToken);
  assert.equal(admin.isAdmin, true);
  assert.equal(admin.isOperator, true);
  assert.equal(admin.isViewer, true);
  assert.equal(admin.canCanva, true);

  // Operator token
  const operatorToken = await makeToken({ groups: [OIDC_GROUPS.OPERATOR] });
  const operator = await verifier.verify(operatorToken);
  assert.equal(operator.isAdmin, false);
  assert.equal(operator.isOperator, true);
  assert.equal(operator.isViewer, true);
  assert.equal(operator.canCanva, false);

  // Viewer token
  const viewerToken = await makeToken({ groups: [OIDC_GROUPS.VIEWER] });
  const viewer = await verifier.verify(viewerToken);
  assert.equal(viewer.isAdmin, false);
  assert.equal(viewer.isOperator, false);
  assert.equal(viewer.isViewer, true);

  // Canva token
  const canvaToken = await makeToken({ groups: [OIDC_GROUPS.CANVA_WRITE] });
  const canva = await verifier.verify(canvaToken);
  assert.equal(canva.canCanva, true);
  assert.equal(canva.isOperator, false);
});

test("OidcVerifier: checkPermission enforces RBAC for church roles", async () => {
  const { jwksMock, makeToken } = await setupKeys();
  const verifier = new OidcVerifier({ jwksOverride: jwksMock });

  const admin = await verifier.verify(await makeToken({ groups: [OIDC_GROUPS.ADMIN] }));
  const operator = await verifier.verify(await makeToken({ groups: [OIDC_GROUPS.OPERATOR] }));
  const viewer = await verifier.verify(await makeToken({ groups: [OIDC_GROUPS.VIEWER] }));
  const canva = await verifier.verify(await makeToken({ groups: [OIDC_GROUPS.CANVA_WRITE] }));
  const randomUser = await verifier.verify(await makeToken({ groups: ["other-group"] }));

  // Read requests: allowed for recognized users, denied for random user
  assert.doesNotThrow(() => verifier.checkPermission(viewer, { method: "GET", url: "/api/v1/status" }));
  assert.throws(() => verifier.checkPermission(randomUser, { method: "GET", url: "/api/v1/status" }), OidcForbiddenError);

  // Mutating requests:
  // Admin: allowed everywhere
  assert.doesNotThrow(() => verifier.checkPermission(admin, { method: "POST", url: "/api/v1/matrix/route" }));

  // Operator: allowed on live hardware
  assert.doesNotThrow(() => verifier.checkPermission(operator, { method: "POST", url: "/api/v1/matrix/route" }));

  // Viewer: refused mutating commands
  assert.throws(() => verifier.checkPermission(viewer, { method: "POST", url: "/api/v1/matrix/route" }), OidcForbiddenError);

  // Canva: allowed on Canva routes, refused on hardware
  assert.doesNotThrow(() => verifier.checkPermission(canva, { method: "POST", url: "/api/v1/canva/push" }));
  assert.throws(() => verifier.checkPermission(canva, { method: "POST", url: "/api/v1/matrix/route" }), OidcForbiddenError);
});

test("buildApp: accepts valid Tunnus Bearer token or static API key on /api/v1", async () => {
  const { jwksMock, makeToken } = await setupKeys();
  const verifier = new OidcVerifier({ jwksOverride: jwksMock });

  const config = loadConfig({
    PIGATEWAY_API_KEY: "static-secret-key",
    PIGATEWAY_OIDC_ENABLED: "true"
  });

  const app = buildApp(config, { oidcVerifier: verifier });

  // 1. Unauthenticated mutating request -> 401
  const unauth = await app.inject({ method: "POST", url: "/api/v1/matrix/route", payload: {} });
  assert.equal(unauth.statusCode, 401);

  // 2. Static API key -> allowed through auth
  const apiKeyRes = await app.inject({
    method: "POST",
    url: "/api/v1/matrix/route",
    headers: { authorization: "Bearer static-secret-key" },
    payload: { input: 1, output: 1 }
  });
  // Route handler executes (may return 200 or route error, but not 401)
  assert.notEqual(apiKeyRes.statusCode, 401);

  // 3. Admin OIDC Bearer token -> allowed through auth
  const adminToken = await makeToken({ groups: [OIDC_GROUPS.ADMIN] });
  const adminRes = await app.inject({
    method: "POST",
    url: "/api/v1/matrix/route",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { input: 1, output: 1 }
  });
  assert.notEqual(adminRes.statusCode, 401);
  assert.notEqual(adminRes.statusCode, 403);

  // 4. Viewer OIDC Bearer token -> 403 Forbidden for mutating request
  const viewerToken = await makeToken({ groups: [OIDC_GROUPS.VIEWER] });
  const viewerMutate = await app.inject({
    method: "POST",
    url: "/api/v1/matrix/route",
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: { input: 1, output: 1 }
  });
  assert.equal(viewerMutate.statusCode, 403);

  // Viewer GET is allowed
  const viewerGet = await app.inject({
    method: "GET",
    url: "/api/v1/status",
    headers: { authorization: `Bearer ${viewerToken}` }
  });
  assert.equal(viewerGet.statusCode, 200);

  // 5. Invalid / expired JWT -> 401 Unauthorized
  const badToken = await makeToken({ iss: "https://attacker.example.com" });
  const badRes = await app.inject({
    method: "POST",
    url: "/api/v1/matrix/route",
    headers: { authorization: `Bearer ${badToken}` }
  });
  assert.equal(badRes.statusCode, 401);

  await app.close();
});

test("UI Listener: withOidcAuth supports Bearer token and login via Tunnus token", async () => {
  const { jwksMock, makeToken } = await setupKeys();
  const verifier = new OidcVerifier({ jwksOverride: jwksMock });

  const pinAuth = createPinAuth({ pin: "secret123" });
  const auth = withOidcAuth(pinAuth, verifier);

  const forwarded: Array<{ rule: UiRouteRule; method: string; url: string; role?: string }> = [];
  const fakeForward = async (rule: UiRouteRule, req: any) => {
    forwarded.push({ rule, method: req.method, url: req.url, role: req.role });
    return { statusCode: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) };
  };

  const silentLogger = (await import("fastify")).default({ logger: { level: "silent" } }).log;

  const app = buildUiListener({
    role: "lan",
    auth,
    forward: fakeForward,
    logger: silentLogger
  });

  // 1. Direct Bearer token with Operator group
  const operatorToken = await makeToken({ groups: [OIDC_GROUPS.OPERATOR] });
  const bearerRes = await app.inject({
    method: "POST",
    url: "/api/v1/matrix/route",
    headers: { authorization: `Bearer ${operatorToken}` },
    payload: { input: 1, output: 1 }
  });
  assert.equal(bearerRes.statusCode, 200);

  // 2. Direct Bearer token with Viewer group -> 403 on POST
  const viewerToken = await makeToken({ groups: [OIDC_GROUPS.VIEWER] });
  const viewerPost = await app.inject({
    method: "POST",
    url: "/api/v1/matrix/route",
    headers: { authorization: `Bearer ${viewerToken}` },
    payload: { input: 1, output: 1 }
  });
  assert.equal(viewerPost.statusCode, 403);

  // Viewer GET on module route is allowed
  const viewerGet = await app.inject({
    method: "GET",
    url: "/api/v1/matrix",
    headers: { authorization: `Bearer ${viewerToken}` }
  });
  assert.equal(viewerGet.statusCode, 200);

  // 3. Login with Tunnus token -> establishes session cookie
  const loginRes = await app.inject({
    method: "POST",
    url: "/ui/api/login",
    payload: { token: operatorToken }
  });
  assert.equal(loginRes.statusCode, 200);
  const cookie = loginRes.headers["set-cookie"] as string;
  assert.ok(cookie && cookie.includes("picontrol_ui="));

  // Request using that session cookie succeeds
  const sessionRes = await app.inject({
    method: "GET",
    url: "/ui/api/session",
    headers: { cookie }
  });
  assert.equal(sessionRes.statusCode, 200);
  assert.equal(sessionRes.json().role, "lan");
  assert.equal(sessionRes.json().user.sub, "user-123");

  await app.close();
});
