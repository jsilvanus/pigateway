import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerMatrixProxyRoutes } from "../src/matrix/matrix-proxy-routes.js";
import { PiMatrixClient } from "../src/matrix/client.js";

test("matrix-proxy-routes returns 503 if client is not configured", async () => {
  const app = Fastify();
  const client = new PiMatrixClient({});
  registerMatrixProxyRoutes(app, { client });

  const res = await app.inject({ method: "GET", url: "/api/v1/sources" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "MATRIX_NOT_CONFIGURED");
  await app.close();
});

test("matrix-proxy-routes proxies sources, outputs, multiview, crops, composites, quick-options", async () => {
  const app = Fastify();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({ method: init?.method ?? "GET", path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (pathname === "/api/v1/sources") {
      return new Response(JSON.stringify([{ id: "cam1" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/api/v1/outputs") {
      return new Response(JSON.stringify([{ id: "hdmi0" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/api/v1/composites") {
      return new Response(JSON.stringify([{ id: "split" }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/api/v1/composites/split/preview.png") {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = new PiMatrixClient({ baseUrl: "http://127.0.0.1:3101", fetchFn: fakeFetch });
  registerMatrixProxyRoutes(app, { client });

  const res1 = await app.inject({ method: "GET", url: "/api/v1/sources" });
  assert.equal(res1.statusCode, 200);

  const res2 = await app.inject({ method: "GET", url: "/api/v1/outputs" });
  assert.equal(res2.statusCode, 200);

  const res3 = await app.inject({ method: "POST", url: "/api/v1/outputs/hdmi0/source", payload: { source: "cam1" } });
  assert.equal(res3.statusCode, 200);

  const res4 = await app.inject({ method: "POST", url: "/api/v1/sources/cam1/effects/crop", payload: { crop: [0, 0, 100, 100] } });
  assert.equal(res4.statusCode, 200);

  const res5 = await app.inject({ method: "GET", url: "/api/v1/composites" });
  assert.equal(res5.statusCode, 200);

  const res6 = await app.inject({ method: "GET", url: "/api/v1/composites/split/preview.png" });
  assert.equal(res6.statusCode, 200);
  assert.equal(res6.headers["content-type"], "image/png");

  assert.equal(calls.length, 6);
  await app.close();
});
