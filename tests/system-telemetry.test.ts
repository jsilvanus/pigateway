import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { registerMatrixProxyRoutes } from "../src/matrix/matrix-proxy-routes.js";
import { PiMatrixClient } from "../src/matrix/client.js";

test("matrix-proxy-routes proxies /api/v1/matrix/telemetry and /api/v1/matrix/status", async () => {
  const app = Fastify();
  const fakeFetch: typeof fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/v1/telemetry") {
      return new Response(JSON.stringify({ service: "pimatrix", fps: { budgetFps: 30, encodeFps: 25, decodeFps: 25 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/status") {
      return new Response(JSON.stringify({ service: "pimatrix", status: "running" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const client = new PiMatrixClient({ baseUrl: "http://127.0.0.1:3101", fetchFn: fakeFetch });
  registerMatrixProxyRoutes(app, { client });

  const tRes = await app.inject({ method: "GET", url: "/api/v1/matrix/telemetry" });
  assert.equal(tRes.statusCode, 200);
  assert.equal(tRes.json().fps.encodeFps, 25);

  const sRes = await app.inject({ method: "GET", url: "/api/v1/matrix/status" });
  assert.equal(sRes.statusCode, 200);
  assert.equal(sRes.json().status, "running");

  await app.close();
});

test("GET /api/v1/system/telemetry returns gateway metrics, ecosystem, and connections", async () => {
  const app = buildApp(loadConfig({ PIGATEWAY_MODE: "simulation" }));
  try {
    const res = await app.inject({ method: "GET", url: "/api/v1/system/telemetry" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.service, "pigateway");
    assert.ok(body.gateway.memory.totalBytes > 0);
    assert.ok(body.system.memory.totalBytes > 0);
    assert.ok(body.ecosystem);
    assert.ok(body.connections);
    assert.equal(typeof body.connections.atem.connected, "boolean");
    assert.equal(body.fffleet.status, "not-configured");
  } finally {
    await app.close();
  }
});
