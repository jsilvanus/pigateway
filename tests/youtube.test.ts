import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerYoutubeRoutes } from "../src/youtube/youtube-routes.js";
import { YoutubeStatusStore, type YoutubeStatusRecord } from "../src/youtube/youtube-status.js";

function setup() {
  let now = 1_000_000;
  const events: YoutubeStatusRecord[] = [];
  const store = new YoutubeStatusStore({ now: () => now, onChange: (r) => events.push(r) });
  const app = Fastify();
  registerYoutubeRoutes(app, store);
  return { app, store, events, advance: (ms: number) => (now += ms) };
}

const body = (over: object = {}) => ({ state: "live", checkedAt: 999_000, ttlMs: 10_000, ...over });

test("unknown until pitube reports", async () => {
  const { app } = setup();
  assert.equal((await app.inject({ url: "/api/v1/youtube" })).json().state, "unknown");
});

test("a report is stored with the gateway receive time and published once per change", async () => {
  const { app, store, events } = setup();
  const res = await app.inject({ method: "PUT", url: "/api/v1/youtube/status", payload: body({ detail: "broadcast x" }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().receivedAt, 1_000_000);
  assert.equal((await app.inject({ url: "/api/v1/youtube" })).json().detail, "broadcast x");
  await app.inject({ method: "PUT", url: "/api/v1/youtube/status", payload: body({ detail: "broadcast x" }) });
  assert.equal(events.length, 1);
  await app.inject({ method: "PUT", url: "/api/v1/youtube/status", payload: body({ state: "offline", detail: "ended" }) });
  assert.equal(events.length, 2);
  store.stop();
});

test("the state reads unknown once the ttl has passed", async () => {
  const { app, store, advance } = setup();
  await app.inject({ method: "PUT", url: "/api/v1/youtube/status", payload: body() });
  advance(9_999);
  assert.equal((await app.inject({ url: "/api/v1/youtube" })).json().state, "live");
  advance(1);
  const after = (await app.inject({ url: "/api/v1/youtube" })).json();
  assert.equal(after.state, "unknown");
  assert.equal(after.detail, "expired");
  store.stop();
});

test("expiry is published as an event", async () => {
  let now = 0;
  const events: YoutubeStatusRecord[] = [];
  const store = new YoutubeStatusStore({ now: () => now, onChange: (r) => events.push(r) });
  store.set({ state: "live", checkedAt: 0, ttlMs: 1000 });
  now = 1000;
  await new Promise((r) => setTimeout(r, 1100));
  store.stop();
  assert.deepEqual(events.map((e) => e.state), ["live", "unknown"]);
});

test("bad bodies are refused", async () => {
  const { app } = setup();
  for (const payload of [
    {}, body({ state: "maybe" }), body({ ttlMs: 10 }), body({ ttlMs: 4_000_000 }), body({ ttlMs: 1500.5 }),
    body({ checkedAt: "now" }), body({ detail: 5 })
  ]) {
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/youtube/status", payload })).statusCode, 422, JSON.stringify(payload));
  }
});
