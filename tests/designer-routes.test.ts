import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerDesignerRoutes } from "../src/designer/designer-routes.js";
import { PiDesignerClient } from "../src/designer/client.js";

test("designer-routes returns 503 if client is not configured", async () => {
  const app = Fastify();
  const client = new PiDesignerClient({});
  registerDesignerRoutes(app, { client });

  const res = await app.inject({ method: "GET", url: "/api/v1/designer/state" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "DESIGNER_NOT_CONFIGURED");
  await app.close();
});

test("designer-routes proxies state, items, templates, and validation", async () => {
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

    if (pathname === "/api/v1/designer/state") {
      return new Response(JSON.stringify({ activeService: "messu", items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/designer/items") {
      return new Response(JSON.stringify({ ok: true, item: { id: "item-1", title: "Alkusoitto" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/templates") {
      return new Response(JSON.stringify([{ id: "messu", name: "Jumalanpalvelus" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/validate") {
      return new Response(JSON.stringify({ valid: true, errors: [], warnings: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const client = new PiDesignerClient({
    baseUrl: "http://upstream-designer:3108",
    token: "secret",
    fetchFn: fakeFetch
  });
  registerDesignerRoutes(app, { client });

  const stateRes = await app.inject({ method: "GET", url: "/api/v1/designer/state" });
  assert.equal(stateRes.statusCode, 200);
  assert.equal(JSON.parse(stateRes.body).activeService, "messu");

  const itemRes = await app.inject({
    method: "POST",
    url: "/api/v1/designer/items",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ item: { title: "Alkusoitto" } })
  });
  assert.equal(itemRes.statusCode, 200);

  const tplRes = await app.inject({ method: "GET", url: "/api/v1/designer/templates" });
  assert.equal(tplRes.statusCode, 200);
  assert.equal(JSON.parse(tplRes.body)[0].id, "messu");

  const valRes = await app.inject({
    method: "POST",
    url: "/api/v1/designer/validate",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yaml: "items: []" })
  });
  assert.equal(valRes.statusCode, 200);
  assert.equal(JSON.parse(valRes.body).valid, true);

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /api/v1/designer/state",
      "POST /api/v1/designer/items",
      "GET /api/v1/templates",
      "POST /api/v1/validate"
    ]
  );

  await app.close();
});
