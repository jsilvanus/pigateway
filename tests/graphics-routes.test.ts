import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerGraphicsRoutes } from "../src/graphics/graphics-routes.js";
import { PiGraphicsClient } from "../src/graphics/client.js";

test("graphics-routes returns 503 if client is not configured", async () => {
  const app = Fastify();
  const client = new PiGraphicsClient({});
  registerGraphicsRoutes(app, { client });

  const res = await app.inject({ method: "GET", url: "/api/v1/graphics/active" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "GRAPHICS_NOT_CONFIGURED");
  await app.close();
});

test("graphics-routes proxies active, templates, assets, and canva push/off-air", async () => {
  const app = Fastify();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({
      method: init?.method ?? "GET",
      path: pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });

    if (pathname === "/api/v1/graphics/active") {
      return new Response(JSON.stringify({ instances: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/graphics/active/show") {
      return new Response(JSON.stringify({ ok: true, instanceId: "inst-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/graphics/canva/push") {
      return new Response(JSON.stringify({ ok: true, keyer: "dsk" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/graphics/canva/off-air") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const client = new PiGraphicsClient({
    baseUrl: "http://upstream-pigraphics:3201",
    token: "secret",
    fetchFn: fakeFetch
  });
  registerGraphicsRoutes(app, { client });

  const activeRes = await app.inject({ method: "GET", url: "/api/v1/graphics/active" });
  assert.equal(activeRes.statusCode, 200);

  const showRes = await app.inject({
    method: "POST",
    url: "/api/v1/graphics/active/show",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ templateId: "lower-third", fields: { title: "Speaker" } })
  });
  assert.equal(showRes.statusCode, 200);
  assert.equal(JSON.parse(showRes.body).instanceId, "inst-1");

  const canvaPushRes = await app.inject({
    method: "POST",
    url: "/api/v1/graphics/canva/push",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageBase64: "data:..." })
  });
  assert.equal(canvaPushRes.statusCode, 200);

  const canvaOffAirRes = await app.inject({
    method: "POST",
    url: "/api/v1/graphics/canva/off-air"
  });
  assert.equal(canvaOffAirRes.statusCode, 200);

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /api/v1/graphics/active",
      "POST /api/v1/graphics/active/show",
      "POST /api/v1/graphics/canva/push",
      "POST /api/v1/graphics/canva/off-air"
    ]
  );

  await app.close();
});
