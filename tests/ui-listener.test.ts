import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { buildUiListener, createOpenAuth, createPinAuth, findUiRoute, type UiRouteRule } from "../src/ui/ui-listener.js";

const logger = Fastify({ logger: { level: "silent" } }).log;

function setup(role: "lan" | "relay") {
  const calls: string[] = [];
  const app = buildUiListener({
    role,
    auth: createPinAuth({ pin: "123456", failDelayMs: 0 }),
    forward: async (rule: UiRouteRule, req) => {
      calls.push(`${req.method} ${req.url} ${rule.module}`);
      return { statusCode: 200, contentType: "application/json", body: "{\"ok\":true}" };
    },
    corsOrigins: ["https://picontrol.example"],
    logger
  });
  return { app, calls };
}

async function login(app: ReturnType<typeof buildUiListener>, pin: string) {
  return app.inject({ method: "POST", url: "/ui/api/login", payload: { pin } });
}

test("allowlist admits module routes and nothing else", () => {
  assert.equal(findUiRoute("GET", "/api/v1/matrix")?.module, "matrix");
  assert.equal(findUiRoute("POST", "/api/v1/encoder/2/start")?.module, "piencoder");
  assert.equal(findUiRoute("POST", "/api/v1/broadcasts/stop/request")?.module, "pitube");
  assert.equal(findUiRoute("POST", "/api/v1/matrix"), null, "method must match");
  assert.equal(findUiRoute("GET", "/api/v1/canva/status"), null);
  assert.equal(findUiRoute("GET", "/api/v1/cameras"), null);
  assert.equal(findUiRoute("POST", "/api/v1/broadcasts/start/extra"), null);
  assert.equal(findUiRoute("GET", "/api/v1/broadcasts/current?x=1")?.module, "pitube");
});

test("module routes need a session; wrong PIN is refused", async () => {
  const { app, calls } = setup("lan");
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/matrix" })).statusCode, 401);
  assert.equal((await login(app, "000000")).statusCode, 401);
  assert.equal((await login(app, "123456")).statusCode, 200);
  assert.deepEqual(calls, []);
  await app.close();
});

test("a valid session is forwarded; the cookie is the only credential", async () => {
  const { app, calls } = setup("lan");
  const res = await login(app, "123456");
  const cookie = String(res.headers["set-cookie"]).split(";")[0] ?? "";
  assert.match(cookie, /^picontrol_ui=/);
  const ok = await app.inject({ method: "POST", url: "/api/v1/matrix/route", headers: { cookie }, payload: { input: 1, output: 2 } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(calls, ["POST /api/v1/matrix/route matrix"]);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/matrix", headers: { cookie: "picontrol_ui=bogus" } })).statusCode, 401);
  await app.close();
});

test("the internet (relay) listener never offers setup routes", async () => {
  const relay = setup("relay");
  const lan = setup("lan");
  for (const { app } of [relay, lan]) {
    const res = await login(app, "123456");
    assert.equal(res.statusCode, 200);
  }
  const cookieRelay = String((await login(relay.app, "123456")).headers["set-cookie"]).split(";")[0] ?? "";
  const cookieLan = String((await login(lan.app, "123456")).headers["set-cookie"]).split(";")[0] ?? "";
  const setupCall = { method: "PUT" as const, url: "/api/v1/encoder/1/settings", payload: { bitrate: 4000 } };
  assert.equal((await relay.app.inject({ ...setupCall, headers: { cookie: cookieRelay } })).statusCode, 403);
  assert.equal((await lan.app.inject({ ...setupCall, headers: { cookie: cookieLan } })).statusCode, 200);
  // pitube RTMP ingest and device config are not on the allowlist at all
  assert.equal((await relay.app.inject({ method: "POST", url: "/api/v1/ingest/apply", headers: { cookie: cookieRelay }, payload: {} })).statusCode, 404);
  assert.equal((await lan.app.inject({ method: "POST", url: "/api/v1/ingest/apply", headers: { cookie: cookieLan }, payload: {} })).statusCode, 404);
  await relay.app.close();
  await lan.app.close();
});

test("LAN listener without a PIN serves module routes; relay still needs the PIN", async () => {
  const lan = buildUiListener({
    role: "lan",
    auth: createOpenAuth(),
    forward: async () => ({ statusCode: 200, contentType: "application/json", body: "{}" }),
    logger
  });
  assert.equal((await lan.inject({ method: "GET", url: "/api/v1/matrix" })).statusCode, 200);
  assert.equal((await lan.inject({ method: "PUT", url: "/api/v1/encoder/1/settings", payload: {} })).statusCode, 200);
  const relay = setup("relay");
  assert.equal((await relay.app.inject({ method: "GET", url: "/api/v1/matrix" })).statusCode, 401);
  await lan.close();
  await relay.app.close();
});

test("relay cookie is SameSite=None and Secure", async () => {
  const relay = buildUiListener({
    role: "relay",
    auth: createPinAuth({ pin: "123456", failDelayMs: 0, sameSite: "None", secure: true }),
    forward: async () => ({ statusCode: 200, contentType: "application/json", body: "{}" }),
    corsOrigins: ["https://keskuskirkko.riihimaenseurakunta.fi"],
    logger
  });
  const res = await relay.inject({ method: "POST", url: "/ui/api/login", payload: { pin: "123456" }, headers: { origin: "https://keskuskirkko.riihimaenseurakunta.fi" } });
  assert.match(String(res.headers["set-cookie"]), /SameSite=None; Secure/);
  assert.equal(res.headers["access-control-allow-origin"], "https://keskuskirkko.riihimaenseurakunta.fi");
  await relay.close();
});

test("disabled modules answer 404 on the listener", async () => {
  const app = buildUiListener({
    role: "lan",
    auth: createOpenAuth(),
    forward: async () => ({ statusCode: 200, contentType: "application/json", body: "{}" }),
    modules: new Set(["matrix"]),
    logger
  });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/matrix" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/status" })).statusCode, 404, "pitube is disabled");
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/encoder/1/start" })).statusCode, 404, "piencoder is disabled");
  await app.close();
});

test("CORS is only for the configured origin, with credentials", async () => {
  const { app } = setup("lan");
  const ok = await app.inject({ method: "OPTIONS", url: "/ui/api/session", headers: { origin: "https://picontrol.example" } });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers["access-control-allow-origin"], "https://picontrol.example");
  assert.equal(ok.headers["access-control-allow-credentials"], "true");
  const other = await app.inject({ method: "OPTIONS", url: "/ui/api/session", headers: { origin: "https://evil.example" } });
  assert.equal(other.statusCode, 403);
  await app.close();
});
