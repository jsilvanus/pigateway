import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerYoutubeRoutes } from "../src/youtube/youtube-routes.js";
import { YoutubeStatusStore } from "../src/youtube/youtube-status.js";
import { PiTubeClient } from "../src/youtube/client.js";

test("youtube-routes returns status from store and updates on PUT", async () => {
  const app = Fastify();
  const store = new YoutubeStatusStore();
  registerYoutubeRoutes(app, store);

  const initial = await app.inject({ method: "GET", url: "/api/v1/youtube" });
  assert.equal(initial.statusCode, 200);
  assert.equal(JSON.parse(initial.body).state, "unknown");

  const now = Date.now();
  const put = await app.inject({
    method: "PUT",
    url: "/api/v1/youtube/status",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      state: "live",
      checkedAt: now,
      ttlMs: 5000,
      detail: "Sunday Service"
    })
  });
  assert.equal(put.statusCode, 200);

  const updated = await app.inject({ method: "GET", url: "/api/v1/youtube" });
  assert.equal(updated.statusCode, 200);
  const data = JSON.parse(updated.body);
  assert.equal(data.state, "live");
  assert.equal(data.detail, "Sunday Service");

  await app.close();
});

test("youtube-routes returns 503 when client is not configured", async () => {
  const app = Fastify();
  const store = new YoutubeStatusStore();
  const client = new PiTubeClient({});
  registerYoutubeRoutes(app, store, client);

  const res = await app.inject({ method: "GET", url: "/api/v1/broadcasts" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "TUBE_NOT_CONFIGURED");

  await app.close();
});

test("youtube-routes proxies broadcasts, streams, privacy, and auth to PiTube", async () => {
  const app = Fastify();
  const store = new YoutubeStatusStore();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({
      method: init?.method ?? "GET",
      path: pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });

    if (pathname === "/api/v1/broadcasts") {
      return new Response(JSON.stringify([{ id: "bc-1", snippet: { title: "Test Broadcast" } }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/broadcasts/current") {
      return new Response(JSON.stringify({ broadcastId: "bc-1", live: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/broadcasts/select") {
      return new Response(JSON.stringify({ ok: true, activeId: "bc-1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/broadcasts/start") {
      return new Response(JSON.stringify({ ok: true, status: "live" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/broadcasts/stop/request") {
      return new Response(JSON.stringify({ confirmToken: "token-abc" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/broadcasts/stop") {
      return new Response(JSON.stringify({ ok: true, status: "complete" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/streams") {
      return new Response(JSON.stringify([{ id: "stream-1", cdn: { ingestionInfo: {} } }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/auth/health") {
      return new Response(JSON.stringify({ healthy: true, authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const client = new PiTubeClient({
    baseUrl: "http://upstream-pitube:3500",
    token: "secret",
    fetchFn: fakeFetch
  });
  registerYoutubeRoutes(app, store, client);

  // 1. GET broadcasts
  const bcRes = await app.inject({ method: "GET", url: "/api/v1/broadcasts" });
  assert.equal(bcRes.statusCode, 200);
  assert.equal(JSON.parse(bcRes.body)[0].id, "bc-1");

  // 2. GET broadcasts/current
  const curRes = await app.inject({ method: "GET", url: "/api/v1/broadcasts/current" });
  assert.equal(curRes.statusCode, 200);
  assert.equal(JSON.parse(curRes.body).broadcastId, "bc-1");

  // 3. POST broadcasts/select
  const selRes = await app.inject({
    method: "POST",
    url: "/api/v1/broadcasts/select",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ broadcastId: "bc-1" })
  });
  assert.equal(selRes.statusCode, 200);
  assert.equal(JSON.parse(selRes.body).ok, true);

  // 4. POST broadcasts/start
  const startRes = await app.inject({
    method: "POST",
    url: "/api/v1/broadcasts/start",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: "live" })
  });
  assert.equal(startRes.statusCode, 200);
  assert.equal(JSON.parse(startRes.body).status, "live");

  // 5. POST broadcasts/stop/request
  const stopReqRes = await app.inject({
    method: "POST",
    url: "/api/v1/broadcasts/stop/request"
  });
  assert.equal(stopReqRes.statusCode, 200);
  assert.equal(JSON.parse(stopReqRes.body).confirmToken, "token-abc");

  // 6. POST broadcasts/stop
  const stopRes = await app.inject({
    method: "POST",
    url: "/api/v1/broadcasts/stop",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmToken: "token-abc" })
  });
  assert.equal(stopRes.statusCode, 200);
  assert.equal(JSON.parse(stopRes.body).status, "complete");

  // 7. GET streams
  const streamsRes = await app.inject({ method: "GET", url: "/api/v1/streams" });
  assert.equal(streamsRes.statusCode, 200);
  assert.equal(JSON.parse(streamsRes.body)[0].id, "stream-1");

  // 8. GET auth/health
  const authRes = await app.inject({ method: "GET", url: "/api/v1/auth/health" });
  assert.equal(authRes.statusCode, 200);
  assert.equal(JSON.parse(authRes.body).healthy, true);

  // Verify paths called upstream
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [
      "GET /api/v1/broadcasts",
      "GET /api/v1/broadcasts/current",
      "POST /api/v1/broadcasts/select",
      "POST /api/v1/broadcasts/start",
      "POST /api/v1/broadcasts/stop/request",
      "POST /api/v1/broadcasts/stop",
      "GET /api/v1/streams",
      "GET /api/v1/auth/health"
    ]
  );

  await app.close();
});
