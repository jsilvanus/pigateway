import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { buildUiListener, createOpenAuth, createPinAuth, findUiRoute, withTrustedAddresses, type UiRouteRule } from "../src/ui/ui-listener.js";

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
  assert.equal(findUiRoute("GET", "/api/v1/matrix")?.module, "pimatrix");
  assert.equal(findUiRoute("POST", "/api/v1/encoder/2/start")?.module, "piencoder");
  assert.equal(findUiRoute("GET", "/api/v1/voice/status")?.module, "pivoice");
  assert.equal(findUiRoute("POST", "/api/v1/voice/capture/start")?.module, "pivoice");
  assert.equal(findUiRoute("GET", "/api/v1/voice/transcripts")?.module, "pivoice");
  assert.equal(findUiRoute("POST", "/api/v1/matrix"), null, "method must match");
  assert.equal(findUiRoute("GET", "/api/v1/canva/status"), null);
  assert.equal(findUiRoute("GET", "/api/v1/cameras")?.lanOnly, true, "cameras: LAN listener only");
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
  assert.deepEqual(calls, ["POST /api/v1/matrix/route pimatrix"]);
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

test("a listener with open auth serves module routes (test adapter only); relay needs the PIN", async () => {
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


test("session lasts 24 h from the last activity, refreshes on use, and logout locks it", async () => {
  let t = 1_000_000;
  const hour = 60 * 60 * 1000;
  const app = buildUiListener({
    role: "lan",
    auth: createPinAuth({ pin: "123456", failDelayMs: 0, now: () => t }),
    forward: async () => ({ statusCode: 200, contentType: "application/json", body: "{}" }),
    logger
  });
  const login = await app.inject({ method: "POST", url: "/ui/api/login", payload: { pin: "123456" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const get = () => app.inject({ method: "GET", url: "/api/v1/matrix", headers: { cookie } });
  t += 20 * hour;
  const active = await get();
  assert.equal(active.statusCode, 200);
  assert.match(String(active.headers["set-cookie"]), /Max-Age=86400/, "activity re-issues the cookie");
  t += 20 * hour; // 40 h since login, 20 h since last activity
  assert.equal((await get()).statusCode, 200, "activity extended the session");
  t += 25 * hour; // idle more than 24 h
  assert.equal((await get()).statusCode, 401);
  // lock button: logout ends the session at once
  const again = await app.inject({ method: "POST", url: "/ui/api/login", payload: { pin: "123456" } });
  const c2 = String(again.headers["set-cookie"]).split(";")[0]!;
  await app.inject({ method: "POST", url: "/ui/api/logout", headers: { cookie: c2 } });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/matrix", headers: { cookie: c2 } })).statusCode, 401);
  await app.close();
});

test("trusted LAN addresses skip the PIN; others, spoofed headers and the relay do not", async () => {
  const mk = (role: "lan" | "relay", trusted: string[]) => buildUiListener({
    role,
    auth: withTrustedAddresses(createPinAuth({ pin: "123456", failDelayMs: 0 }), trusted),
    forward: async () => ({ statusCode: 200, contentType: "application/json", body: "{}" }),
    logger
  });
  const lan = mk("lan", ["192.168.1.98"]);
  const get = (remoteAddress: string, headers: Record<string, string> = {}) => lan.inject({ method: "GET", url: "/api/v1/matrix", remoteAddress, headers });
  assert.equal((await get("192.168.1.98")).statusCode, 200, "trusted socket address");
  assert.equal((await get("::ffff:192.168.1.98")).statusCode, 200, "mapped IPv4 form");
  assert.equal((await get("192.168.1.50")).statusCode, 401, "other LAN host");
  assert.equal((await get("192.168.1.50", { "x-forwarded-for": "192.168.1.98", "x-real-ip": "192.168.1.98" })).statusCode, 401, "headers from a non-loopback peer are ignored");
  assert.equal((await get("127.0.0.1", { "x-forwarded-for": "192.168.1.98" })).statusCode, 401, "X-Forwarded-For is never read");
  assert.equal((await get("127.0.0.1", { "x-real-ip": "192.168.1.98" })).statusCode, 200, "nginx on loopback passes the client in X-Real-IP");
  assert.equal((await get("127.0.0.1", { "x-real-ip": "192.168.1.50" })).statusCode, 401);
  await lan.close();
});

test("event stream: needs a session, always limited to the UI event types, client cannot widen it", async () => {
  const seen: string[] = [];
  const app = buildUiListener({
    role: "lan",
    auth: createPinAuth({ pin: "123456", failDelayMs: 0 }),
    forward: async () => ({ statusCode: 200, contentType: "application/json", body: "{}" }),
    openEvents: async (query) => {
      seen.push(query);
      return { status: 200, body: new Response("event: ready\ndata: {}\n\n").body };
    },
    logger
  });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/events" })).statusCode, 401, "no session");
  const login = await app.inject({ method: "POST", url: "/ui/api/login", payload: { pin: "123456" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const res = await app.inject({ method: "GET", url: "/api/v1/events?client=picontrol&types=transcript,perception", headers: { cookie } });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /text\/event-stream/);
  assert.match(res.body, /event: ready/);
  const params = new URLSearchParams(seen[0]);
  assert.equal(params.get("client"), "picontrol");
  const types = params.get("types")!.split(",");
  assert.ok(types.includes("matrix") && types.includes("ecosystem"));
  for (const hidden of ["transcript", "perception", "rundown", "world-state", "screen-tracking"]) assert.ok(!types.includes(hidden), hidden);
  await app.close();
});

test("event stream answers 404 when the gateway gave no stream source", async () => {
  const app = buildUiListener({ role: "lan", auth: createOpenAuth(), forward: async () => ({ statusCode: 200, contentType: "application/json", body: "{}" }), logger });
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/events" })).statusCode, 404);
  await app.close();
});

test("the routes behind the Outputs, Cameras and Pipeline tabs are on the allowlist; presets are setup-only", () => {
  const rule = (m: string, u: string) => findUiRoute(m, u);
  for (const [m, u] of [
    ["POST", "/api/v1/outputs/hdmi0/source"], ["POST", "/api/v1/outputs/multiview/layout"], ["POST", "/api/v1/outputs/rtsp/source"],
    ["POST", "/api/v1/sources/cam1/effects/crop"], ["GET", "/api/v1/effects?includeHidden=true"], ["GET", "/api/v1/ecosystem"],
    ["GET", "/api/v1/cameras"], ["POST", "/api/v1/cameras/cam1/move"], ["POST", "/api/v1/cameras/cam1/presets/2/recall"],
    ["GET", "/api/v1/video-mixer"], ["PUT", "/api/v1/video-mixer/program"], ["POST", "/api/v1/video-mixer/cut"], ["POST", "/api/v1/encoder/start"]
  ] as const) assert.ok(rule(m, u), `${m} ${u}`);
  assert.equal(rule("POST", "/api/v1/cameras/cam1/presets/2/save")?.setup, true);
  // not opened: camera stream control, free-d, power-off style and device config stay off the UI listeners
  assert.equal(rule("POST", "/api/v1/cameras/cam1/stream/start"), null);
  assert.equal(rule("POST", "/api/v1/cameras/cam1/freed"), null);
});

test("camera and ATEM routes are served on the LAN listener and refused on the relay", async () => {
  for (const [role, expected] of [["lan", 200], ["relay", 403]] as const) {
    const { app } = setup(role);
    const login2 = await app.inject({ method: "POST", url: "/ui/api/login", payload: { pin: "123456" } });
    const cookie = String(login2.headers["set-cookie"]).split(";")[0]!;
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/cameras", headers: { cookie } })).statusCode, expected, `${role} cameras`);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/video-mixer/cut", headers: { cookie } })).statusCode, expected, `${role} atem`);
    await app.close();
  }
});
