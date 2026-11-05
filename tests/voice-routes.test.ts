import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerVoiceRoutes } from "../src/pivoice/voice-routes.js";
import { PiVoiceClient } from "../src/pivoice/client.js";

test("voice-routes returns 503 if client is not configured", async () => {
  const app = Fastify();
  const client = new PiVoiceClient({});
  const transcripts = {
    recent: () => []
  };
  registerVoiceRoutes(app, { client, transcripts });

  const res = await app.inject({ method: "GET", url: "/api/v1/voice/status" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "VOICE_NOT_CONFIGURED");
  await app.close();
});

test("voice-routes proxies GET status, config, radio, captions, mixer, and audio devices", async () => {
  const app = Fastify();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({ method: init?.method ?? "GET", path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (pathname === "/api/v1/status") {
      return new Response(JSON.stringify({ capture: { state: "running" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/config") {
      return new Response(JSON.stringify({ radio: { targets: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/radio") {
      return new Response(JSON.stringify({ targets: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/captions" || pathname === "/api/v1/captions/status") {
      return new Response(JSON.stringify({ running: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/audio/devices") {
      return new Response(JSON.stringify({ devices: ["hw:0,0"] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/audio/mixer") {
      return new Response(JSON.stringify({ volume: 80 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const client = new PiVoiceClient({ baseUrl: "http://127.0.0.1:3106", token: "secret-token", fetchFn: fakeFetch });
  const transcripts = {
    epoch: 12345,
    since: (_after?: string, limit?: number) => [{ id: "t1", text: "Hello test", limit }]
  };
  registerVoiceRoutes(app, { client, transcripts });

  const statusRes = await app.inject({ method: "GET", url: "/api/v1/voice/status" });
  assert.equal(statusRes.statusCode, 200);
  assert.deepEqual(JSON.parse(statusRes.body), { capture: { state: "running" } });

  const configRes = await app.inject({ method: "GET", url: "/api/v1/voice/config" });
  assert.equal(configRes.statusCode, 200);

  const radioRes = await app.inject({ method: "GET", url: "/api/v1/voice/radio" });
  assert.equal(radioRes.statusCode, 200);

  const transcriptsRes = await app.inject({ method: "GET", url: "/api/v1/voice/transcripts?limit=5" });
  assert.equal(transcriptsRes.statusCode, 200);
  assert.deepEqual(JSON.parse(transcriptsRes.body), { epoch: 12345, transcripts: [{ id: "t1", text: "Hello test", limit: 5 }] });

  const captionsRes = await app.inject({ method: "GET", url: "/api/v1/voice/captions" });
  assert.equal(captionsRes.statusCode, 200);

  assert.equal(calls.length, 4);
  await app.close();
});

test("voice-routes proxies capture start/stop and radio target mode", async () => {
  const app = Fastify();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({ method: init?.method ?? "GET", path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (pathname === "/api/v1/capture/start" || pathname === "/api/v1/capture/stop") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/config") {
      return new Response(JSON.stringify({ radio: { targets: [{ id: "icecast", mode: "auto" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  };

  const client = new PiVoiceClient({ baseUrl: "http://127.0.0.1:3106", token: "secret-token", fetchFn: fakeFetch });
  registerVoiceRoutes(app, { client, transcripts: { recent: () => [] } });

  const startRes = await app.inject({ method: "POST", url: "/api/v1/voice/capture/start" });
  assert.equal(startRes.statusCode, 200);

  const stopRes = await app.inject({ method: "POST", url: "/api/v1/voice/capture/stop" });
  assert.equal(stopRes.statusCode, 200);

  const radioModeRes = await app.inject({
    method: "PUT",
    url: "/api/v1/voice/radio/icecast/mode",
    payload: { mode: "auto" }
  });
  assert.equal(radioModeRes.statusCode, 200);

  assert.equal(calls.some(c => c.path === "/api/v1/capture/start"), true);
  assert.equal(calls.some(c => c.path === "/api/v1/capture/stop"), true);
  assert.equal(calls.some(c => c.path === "/api/v1/config" && c.method === "PUT"), true);

  await app.close();
});
