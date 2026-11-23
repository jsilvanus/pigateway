import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { hasRight, parseGroupRights, rightsForGroups } from "../src/auth/rights.js";
import { createTunnusVerifier } from "../src/auth/tunnus.js";
import { buildCanvaTunnelApp } from "../src/canva/canva-tunnel.js";
import { CanvaService } from "../src/canva/canva-service.js";
import { ActionListStore } from "../src/actions/action-lists.js";

const quiet = Fastify({ logger: false }).log;

/** A tiny fake Tunnus: discovery, JWKS and a token signer. Keys can be rotated. */
async function fakeTunnus() {
  let kid = "k1";
  let { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let up = true;
  const server: Server = createServer((req, res) => {
    if (!up) return void res.writeHead(503).end();
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.url === "/.well-known/openid-configuration") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: base, jwks_uri: `${base}/jwks` }));
    if (req.url === "/jwks") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const mint = (claims: Record<string, unknown> = {}, key: KeyObject = privateKey, keyId = kid) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = { iss: issuer, sub: "user-1", name: "Test Person", aud: ["pigateway", "sissi"], groups: ["g-content"], exp: Math.floor(Date.now() / 1000) + 600, ...claims };
    const head = enc({ alg: "RS256", typ: "JWT", kid: keyId });
    const payload = enc(body);
    return `${head}.${payload}.${sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), key).toString("base64url")}`;
  };
  return {
    issuer,
    mint,
    rotate() {
      ({ privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }));
      kid = "k2";
    },
    setUp(value: boolean) { up = value; },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const GROUPS = "g-content=@content;g-op=@operator;g-both=canva:write,canva:operate;g-pi=piprogram:write,@viewer";
const service = () => new CanvaService({ piprogramUrl: "http://pg", fetchFn: async () => new Response("{}", { status: 404 }) });

test("group rights: presets, union, wildcard never covers canva, admin includes the rest", () => {
  const map = parseGroupRights(GROUPS);
  const content = rightsForGroups(map, ["g-content"]);
  assert.ok(hasRight(content, "canva", "write"));
  assert.ok(hasRight(content, "canva", "read"));
  assert.ok(!hasRight(content, "canva", "operate"));
  assert.ok(hasRight(content, "piprogram", "read"));
  const op = rightsForGroups(map, ["g-op"]);
  assert.ok(hasRight(op, "canva", "operate") && !hasRight(op, "canva", "write"));
  assert.ok(hasRight(op, "picam", "operate"));
  // piprogram:write / *:read give nothing on canva.
  assert.ok(!hasRight(rightsForGroups(map, ["g-pi"]), "canva", "read"));
  assert.ok(!hasRight(rightsForGroups(map, ["nobody"]), "canva", "read"));
  assert.ok(hasRight(rightsForGroups(parseGroupRights("a=@admin"), ["a"]), "canva", "operate"));
  assert.throws(() => parseGroupRights("a=oops"));
  assert.throws(() => parseGroupRights("a=@nope"));
  assert.throws(() => parseGroupRights("noequals"));
});

test("verifier: good token, and iss, aud, exp, signature and alg are all enforced", async () => {
  const t = await fakeTunnus();
  try {
    const v = createTunnusVerifier({ issuer: t.issuer, audience: "pigateway" });
    const claims = await v.verify(t.mint());
    assert.equal(claims.sub, "user-1");
    assert.deepEqual(claims.groups, ["g-content"]);
    await assert.rejects(v.verify(t.mint({ iss: "https://evil.example" })), /issuer/);
    await assert.rejects(v.verify(t.mint({ aud: ["sissi"] })), /not for this service/);
    await assert.rejects(v.verify(t.mint({ aud: "other" })), /not for this service/);
    assert.equal((await v.verify(t.mint({ aud: "pigateway" }))).sub, "user-1", "aud may be a string");
    await assert.rejects(v.verify(t.mint({ exp: Math.floor(Date.now() / 1000) - 600 })), /expired/);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    await assert.rejects(v.verify(t.mint({}, other)), /signature/);
    const tampered = t.mint().split(".");
    tampered[1] = Buffer.from(JSON.stringify({ iss: t.issuer, sub: "x", aud: ["pigateway"], groups: ["g-both"], exp: 9999999999 })).toString("base64url");
    await assert.rejects(v.verify(tampered.join(".")), /signature/);
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.`;
    await assert.rejects(v.verify(none), /RS256/);
  } finally {
    await t.close();
  }
});

test("verifier: key rotation is picked up, and the last key set survives Tunnus being down", async () => {
  const t = await fakeTunnus();
  try {
    let clock = Date.now();
    const v = createTunnusVerifier({ issuer: t.issuer, audience: "pigateway", now: () => clock });
    await v.verify(t.mint());
    t.rotate();
    clock += 60_000;
    await v.verify(t.mint());
    t.setUp(false);
    clock += 60 * 60_000; // key set is stale, refresh fails, cached keys are still used
    await v.verify(t.mint({ exp: Math.floor(clock / 1000) + 600 }));
    const fresh = createTunnusVerifier({ issuer: t.issuer, audience: "pigateway" });
    await assert.rejects(fresh.verify(t.mint()), (e: Error) => (e as { code?: string }).code === "JWKS_UNAVAILABLE");
  } finally {
    await t.close();
  }
});

test("canva listener with Tunnus: rights per route, session endpoint, key fallback flag", async () => {
  const t = await fakeTunnus();
  try {
    const verifier = createTunnusVerifier({ issuer: t.issuer, audience: "pigateway" });
    const mk = (allowApiKey: boolean) =>
      buildCanvaTunnelApp({ apiKey: "secret", allowApiKey, tunnus: { verifier, groupRights: parseGroupRights(GROUPS) } }, service(), { actionLists: { store: new ActionListStore({}) } }, quiet);
    const app = mk(true);
    const call = (token: string, method: "GET" | "POST", url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

    const content = t.mint({ groups: ["g-content"] });
    const operate = t.mint({ groups: ["g-op"] });
    const none = t.mint({ groups: ["g-pi"] });

    const session = await call(content, "GET", "/api/v1/canva/session");
    assert.equal(session.statusCode, 200);
    assert.deepEqual(session.json(), { auth: "tunnus", name: "Test Person", rights: ["canva:read", "canva:write"] });
    assert.deepEqual((await call(t.mint({ groups: ["g-both"] }), "GET", "/api/v1/canva/session")).json().rights, ["canva:read", "canva:write", "canva:operate"]);

    assert.equal((await call(none, "GET", "/api/v1/canva/session")).statusCode, 403, "no canva right = no access");
    assert.equal((await call(t.mint({ groups: [] }), "GET", "/api/v1/canva/session")).statusCode, 403, "no groups = no access");
    assert.equal((await call(t.mint({ aud: ["sissi"] }), "GET", "/api/v1/canva/session")).statusCode, 401, "aud without pigateway");
    assert.equal((await call(t.mint({ exp: 1 }), "GET", "/api/v1/canva/session")).statusCode, 401);

    // write: push is allowed (422 = it got past rights and failed validation), setup/control need operate.
    assert.equal((await call(content, "POST", "/api/v1/canva/push", { pages: [] })).statusCode, 422);
    assert.equal((await call(content, "POST", "/api/v1/canva/setup", {})).statusCode, 403);
    assert.equal((await call(content, "POST", "/api/v1/canva/control", { action: "next" })).statusCode, 403);
    // operate holders can control but not push.
    assert.equal((await call(operate, "POST", "/api/v1/canva/push", { pages: [] })).statusCode, 403);
    assert.equal((await call(operate, "POST", "/api/v1/canva/setup", {})).statusCode, 422);
    assert.equal((await call(operate, "POST", "/api/v1/canva/control", { action: "bogus" })).statusCode, 422);
    assert.equal((await call(operate, "GET", "/api/v1/canva/tasks/nope")).statusCode, 404, "read is included in operate");

    // action lists: playlist-only = write; anything live = operate.
    const playlist = { name: "p", steps: [{ action: "pipgm:playlist-set", params: { feed: "pipgm1", itemIds: ["a"] } }] };
    const live = { name: "l", steps: [{ action: "pipgm:ftb", params: { feed: "pipgm1", on: true } }] };
    assert.equal((await call(content, "POST", "/api/v1/canva/action-lists", playlist)).statusCode, 201);
    assert.equal((await call(content, "POST", "/api/v1/canva/action-lists", live)).statusCode, 403);
    assert.equal((await call(operate, "POST", "/api/v1/canva/action-lists", playlist)).statusCode, 403);
    assert.equal((await call(t.mint({ groups: ["g-both"] }), "POST", "/api/v1/canva/action-lists", live)).statusCode, 201);

    // No camera or other gateway route exists on this listener; whatever the rights, it is refused.
    for (const path of ["/api/v1/cameras", "/api/v1/matrix", "/api/v1/atem"]) {
      assert.equal((await call(t.mint({ groups: ["g-both"] }), "GET", path)).statusCode, 403, path);
    }

    // The shared key still works while the fallback is on, with full canva rights.
    const key = await call("secret", "GET", "/api/v1/canva/session");
    assert.deepEqual(key.json(), { auth: "key", name: null, rights: ["canva:read", "canva:write", "canva:operate"] });
    // And is refused when the flag is off, while Tunnus keeps working.
    const strict = mk(false);
    assert.equal((await strict.inject({ url: "/api/v1/canva/session", headers: { authorization: "Bearer secret" } })).statusCode, 401);
    assert.equal((await strict.inject({ url: "/api/v1/canva/session", headers: { authorization: `Bearer ${content}` } })).statusCode, 200);
  } finally {
    await t.close();
  }
});

test("canva listener: with Tunnus off nothing changes, and a Tunnus-shaped JWT is not accepted", async () => {
  const t = await fakeTunnus();
  try {
    const app = buildCanvaTunnelApp({ apiKey: "secret" }, service(), {}, quiet);
    assert.equal((await app.inject({ url: "/api/v1/canva/status", headers: { authorization: `Bearer ${t.mint()}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/v1/canva/session", headers: { authorization: "Bearer secret" } })).statusCode, 200);
  } finally {
    await t.close();
  }
});
