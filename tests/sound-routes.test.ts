import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerSoundRoutes } from "../src/pisound/pisound-routes.js";
import { PiSoundClient } from "../src/pisound/client.js";

test("sound-routes returns 503 if client is not configured", async () => {
  const app = Fastify();
  const client = new PiSoundClient({});
  registerSoundRoutes(app, { client });

  const res = await app.inject({ method: "GET", url: "/api/v1/mixes" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "SOUND_NOT_CONFIGURED");
  await app.close();
});

test("sound-routes proxies GET mixes, mixId, profiles, sound status and POST volume/mute/channel/reset", async () => {
  const app = Fastify();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({ method: init?.method ?? "GET", path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (pathname === "/api/v1/mixes") {
      return new Response(JSON.stringify({ mixes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/mixes/sali") {
      return new Response(JSON.stringify({ mixId: "sali", channels: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/mixes/sali/master/volume") {
      return new Response(JSON.stringify({ ok: true, volumePercent: 75 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/mixes/sali/master/mute") {
      return new Response(JSON.stringify({ ok: true, muted: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/mixes/sali/channels/ch1") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/mixes/sali/channels/ch1/toggle") {
      return new Response(JSON.stringify({ ok: true, toggled: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/reset") {
      return new Response(JSON.stringify({ ok: true, reset: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/mics/ch1/solo") {
      return new Response(JSON.stringify({ ok: true, solo: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/profiles") {
      return new Response(JSON.stringify({ profiles: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (pathname === "/api/v1/status") {
      return new Response(JSON.stringify({ service: "pisound" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = new PiSoundClient({ baseUrl: "http://127.0.0.1:3105", token: "sound-token", fetchFn: fakeFetch });
  registerSoundRoutes(app, { client });

  const res1 = await app.inject({ method: "GET", url: "/api/v1/mixes" });
  assert.equal(res1.statusCode, 200);
  assert.deepEqual(JSON.parse(res1.body), { mixes: [] });

  const res2 = await app.inject({ method: "GET", url: "/api/v1/mixes/sali" });
  assert.equal(res2.statusCode, 200);

  const res3 = await app.inject({ method: "POST", url: "/api/v1/mixes/sali/master/volume", payload: { volumePercent: 75 } });
  assert.equal(res3.statusCode, 200);

  const res4 = await app.inject({ method: "POST", url: "/api/v1/reset" });
  assert.equal(res4.statusCode, 200);

  const res5 = await app.inject({ method: "POST", url: "/api/v1/mics/ch1/solo" });
  assert.equal(res5.statusCode, 200);

  const res6 = await app.inject({ method: "GET", url: "/api/v1/profiles" });
  assert.equal(res6.statusCode, 200);

  const res7 = await app.inject({ method: "GET", url: "/api/v1/sound/status" });
  assert.equal(res7.statusCode, 200);

  assert.equal(calls.length, 7);
  await app.close();
});
