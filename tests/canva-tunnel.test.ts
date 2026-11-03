import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { buildCanvaTunnelApp } from "../src/canva/canva-tunnel.js";
import { CanvaService } from "../src/canva/canva-service.js";

const quiet = Fastify({ logger: false }).log;
const service = () => new CanvaService({ piprogramUrl: "http://pg", fetchFn: async () => new Response("{}", { status: 404 }) });
const ORIGIN = "https://app-abc.canva-apps.com";

test("canva tunnel: only the Canva routes exist, and every request needs the key", async () => {
  const app = buildCanvaTunnelApp({ apiKey: "secret", corsOrigins: [ORIGIN] }, service(), {}, quiet);
  const status = (url: string, headers: Record<string, string> = {}, method: "GET" | "POST" = "GET") =>
    app.inject({ method, url, headers, ...(method === "POST" ? { payload: { pages: [] } } : {}) }).then((r) => r.statusCode);

  assert.equal(await status("/api/v1/canva/status"), 401, "reads need the key too");
  assert.equal(await status("/api/v1/canva/status", { authorization: "Bearer wrong" }), 401);
  assert.equal(await status("/api/v1/canva/tasks/nope", { authorization: "Bearer secret" }), 404);
  assert.equal(await status("/api/v1/canva/tasks/nope", { "x-api-key": "secret" }), 404);
  assert.equal(await status("/api/v1/canva/push", { authorization: "Bearer secret" }, "POST"), 422);
  // Everything else on the gateway is simply not here (404 with the key, 401 without).
  for (const path of ["/api/v1/atem", "/api/v1/cameras", "/api/v1/matrix", "/api/v1/projectors/proj1", "/health"]) {
    assert.equal(await status(path, { authorization: "Bearer secret" }), 404, path);
    assert.equal(await status(path), 401, path);
  }
});

test("canva tunnel: the allow-list and forwarded headers do not skip the key", async () => {
  const app = buildCanvaTunnelApp({ apiKey: "secret" }, service(), {}, quiet);
  const res = await app.inject({ method: "GET", url: "/api/v1/canva/status", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "192.168.1.10" } });
  assert.equal(res.statusCode, 401);
});

test("canva tunnel: without a configured key it refuses everything", async () => {
  const app = buildCanvaTunnelApp({}, service(), {}, quiet);
  assert.equal((await app.inject({ url: "/api/v1/canva/status" })).statusCode, 503);
  assert.equal((await app.inject({ url: "/api/v1/canva/status", headers: { authorization: "Bearer " } })).statusCode, 503);
});

test("canva tunnel: CORS only for the configured origin, preflight needs no key", async () => {
  const app = buildCanvaTunnelApp({ apiKey: "secret", corsOrigins: [ORIGIN] }, service(), {}, quiet);
  const pre = await app.inject({ method: "OPTIONS", url: "/api/v1/canva/push", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
  const other = await app.inject({ method: "OPTIONS", url: "/api/v1/canva/push", headers: { origin: "https://evil.example" } });
  assert.equal(other.statusCode, 403);
  assert.equal(other.headers["access-control-allow-origin"], undefined);

  const ok = await app.inject({ url: "/api/v1/canva/tasks/x", headers: { origin: ORIGIN, authorization: "Bearer secret" } });
  assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
  const evil = await app.inject({ url: "/api/v1/canva/tasks/x", headers: { origin: "https://evil.example", authorization: "Bearer secret" } });
  assert.equal(evil.headers["access-control-allow-origin"], undefined);
});
