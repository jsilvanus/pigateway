import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerPiPgmRoutes } from "../src/pipgm/pipgm-routes.js";
import { PiProgramClient } from "../src/pipgm/client.js";

test("pipgm-routes returns 503 if client is not configured", async () => {
  const app = Fastify();
  const client = new PiProgramClient({});
  registerPiPgmRoutes(app, { client });

  const res = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "PIPGM_NOT_CONFIGURED");
  await app.close();
});

test("pipgm-routes proxies pipelines, controls, items, and canva ingestion", async () => {
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

    if (pathname === "/api/v1/pipgm/pipelines") {
      return new Response(JSON.stringify([{ id: "PiPGM1", orientation: "landscape" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/pipgm/pipelines/PiPGM1/cue") {
      return new Response(JSON.stringify({ ok: true, cued: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/pipgm/items") {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/pipgm/items/canva") {
      return new Response(JSON.stringify({ id: "item-canva-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const client = new PiProgramClient({
    baseUrl: "http://upstream-piprogram:3104",
    token: "secret",
    fetchFn: fakeFetch
  });
  registerPiPgmRoutes(app, { client });

  const pipelinesRes = await app.inject({ method: "GET", url: "/api/v1/pipgm/pipelines" });
  assert.equal(pipelinesRes.statusCode, 200);
  assert.equal(JSON.parse(pipelinesRes.body)[0].id, "PiPGM1");

  const cueRes = await app.inject({
    method: "POST",
    url: "/api/v1/pipgm/pipelines/PiPGM1/cue",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemId: "item-1", stepIndex: 0 })
  });
  assert.equal(cueRes.statusCode, 200);

  const itemsRes = await app.inject({ method: "GET", url: "/api/v1/pipgm/items" });
  assert.equal(itemsRes.statusCode, 200);

  const canvaRes = await app.inject({
    method: "POST",
    url: "/api/v1/pipgm/items/canva",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Presentation" })
  });
  assert.equal(canvaRes.statusCode, 200);
  assert.equal(JSON.parse(canvaRes.body).id, "item-canva-1");

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /api/v1/pipgm/pipelines",
      "POST /api/v1/pipgm/pipelines/PiPGM1/cue",
      "GET /api/v1/pipgm/items",
      "POST /api/v1/pipgm/items/canva"
    ]
  );

  await app.close();
});
