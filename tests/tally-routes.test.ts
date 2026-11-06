import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerTallyRoutes } from "../src/tally/tally-routes.js";
import { PiTallyClient } from "../src/tally/client.js";

test("tally-routes returns 503 if client is not configured", async () => {
  const app = Fastify();
  const client = new PiTallyClient({});
  registerTallyRoutes(app, { client });

  const res = await app.inject({ method: "GET", url: "/api/v1/lights" });
  assert.equal(res.statusCode, 503);
  const data = JSON.parse(res.body);
  assert.equal(data.error.code, "TALLY_NOT_CONFIGURED");
  await app.close();
});

test("tally-routes proxies list, create, state, cue, call, hold, brightness, cycle, segments", async () => {
  const app = Fastify();
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const pathname = new URL(url).pathname;
    calls.push({ method: init?.method ?? "GET", path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (pathname === "/api/v1/lights") {
      return new Response(JSON.stringify([{ id: "tally01" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = new PiTallyClient({ baseUrl: "http://127.0.0.1:3107", fetchFn: fakeFetch });
  registerTallyRoutes(app, { client });

  const res1 = await app.inject({ method: "GET", url: "/api/v1/lights" });
  assert.equal(res1.statusCode, 200);

  const res2 = await app.inject({ method: "POST", url: "/api/v1/lights/tally01/state", payload: { mode: "pgm" } });
  assert.equal(res2.statusCode, 200);

  const res3 = await app.inject({ method: "POST", url: "/api/v1/lights/tally01/cue", payload: { direction: "pan-left" } });
  assert.equal(res3.statusCode, 200);

  const res4 = await app.inject({ method: "POST", url: "/api/v1/lights/tally01/call" });
  assert.equal(res4.statusCode, 200);

  const res5 = await app.inject({ method: "POST", url: "/api/v1/lights/tally01/cycle" });
  assert.equal(res5.statusCode, 200);

  assert.equal(calls.length, 5);
  await app.close();
});
