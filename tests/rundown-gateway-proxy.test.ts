import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRundownRoutes } from "../src/rundown/rundown-routes.js";
import { RundownStore } from "../src/rundown/rundown-store.js";
import { GatewayEventBroker } from "../src/events.js";

test("pigateway: proxies /api/v1/rundown/storage to pirundown over gateway", async () => {
  const app = Fastify();
  const eventBroker = new GatewayEventBroker();
  const store = new RundownStore({ eventBroker });

  // Mock fetchFn simulating pirundown service behind the gateway
  const mockFetch: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.endsWith("/api/v1/storage")) {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, item: { id: "mass", title: "Sunday Mass" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, count: 1, rundowns: [{ id: "mass", title: "Sunday Mass" }] }), { status: 200 });
    }
    if (urlStr.endsWith("/api/v1/storage/mass")) {
      return new Response(JSON.stringify({ ok: true, rundown: { id: "mass", title: "Sunday Mass", yaml: "version: 2\ntitle: Sunday Mass" } }), { status: 200 });
    }
    if (urlStr.endsWith("/api/v1/storage/mass/load")) {
      return new Response(JSON.stringify({ ok: true, loadedId: "mass" }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  };

  registerRundownRoutes(app, store, {
    pirundownUrl: "http://127.0.0.1:3400",
    fetchFn: mockFetch,
  });

  // 1. GET /api/v1/rundown/storage over gateway
  const listRes = await app.inject({
    method: "GET",
    url: "/api/v1/rundown/storage",
  });
  assert.equal(listRes.statusCode, 200);
  const listData = JSON.parse(listRes.body);
  assert.equal(listData.ok, true);
  assert.equal(listData.count, 1);

  // 2. POST /api/v1/rundown/storage over gateway
  const postRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/storage",
    payload: { id: "mass", yaml: "version: 2" },
  });
  assert.equal(postRes.statusCode, 200);
  const postData = JSON.parse(postRes.body);
  assert.equal(postData.ok, true);

  // 3. POST /api/v1/rundown/storage/:id/load over gateway
  const loadRes = await app.inject({
    method: "POST",
    url: "/api/v1/rundown/storage/mass/load",
  });
  assert.equal(loadRes.statusCode, 200);
  const loadData = JSON.parse(loadRes.body);
  assert.equal(loadData.ok, true);
});
