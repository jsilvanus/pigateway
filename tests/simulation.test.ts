import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

async function sim() {
  const config = loadConfig({ PIGATEWAY_MODE: "simulation", PIGATEWAY_FREED_UDP_PORT: "0" });
  const built = await buildApp(config);
  const app = "app" in built ? built.app : built;
  await app.ready();
  return app;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("simulation mode: ATEM connects and switches like hardware", async (t) => {
  const app = await sim();
  t.after(() => app.close());
  await wait(100);
  let res = await app.inject({ method: "GET", url: "/api/v1/atem" });
  assert.equal(res.json().connected, true);
  assert.equal(res.json().programInput, 1);

  res = await app.inject({ method: "PUT", url: "/api/v1/atem/preview", payload: { input: 3 } });
  assert.equal(res.statusCode < 300, true);
  res = await app.inject({ method: "POST", url: "/api/v1/atem/cut" });
  assert.equal(res.statusCode < 300, true);
  res = await app.inject({ method: "GET", url: "/api/v1/atem" });
  assert.equal(res.json().programInput, 3);
  assert.equal(res.json().previewInput, 1);

  await app.inject({ method: "PUT", url: "/api/v1/atem/dsk/1/tie", payload: { tie: true } });
  res = await app.inject({ method: "GET", url: "/api/v1/atem" });
  assert.equal(res.json().downstreamKeyers[0].tie, true);

  await app.inject({ method: "POST", url: "/api/v1/atem/auto" });
  res = await app.inject({ method: "GET", url: "/api/v1/atem" });
  assert.equal(res.json().transition.inTransition, true);
  await wait(1200);
  res = await app.inject({ method: "GET", url: "/api/v1/atem" });
  assert.equal(res.json().transition.inTransition, false);
  assert.equal(res.json().programInput, 1);
});

test("simulation mode: matrix has routes and follows route commands", async (t) => {
  const app = await sim();
  t.after(() => app.close());
  let res = await app.inject({ method: "GET", url: "/api/v1/matrix" });
  assert.equal(res.json().routes["3"], 1);
  res = await app.inject({ method: "POST", url: "/api/v1/matrix/route", payload: { input: 4, output: 3 } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: "GET", url: "/api/v1/matrix" });
  assert.equal(res.json().routes["3"], 4);
});

test("simulation mode: encoder is configured and starts/stops", async (t) => {
  const app = await sim();
  t.after(() => app.close());
  let res = await app.inject({ method: "GET", url: "/api/v1/encoder" });
  assert.equal(res.json().configured, true);
  res = await app.inject({ method: "POST", url: "/api/v1/encoder/start", payload: { encoder: 1 } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().encoder1.state, "ON");
  res = await app.inject({ method: "POST", url: "/api/v1/encoder/stop", payload: { encoder: "both" } });
  assert.equal(res.json().encoder1.state, "READY");
  res = await app.inject({ method: "PUT", url: "/api/v1/encoder/settings", payload: { bitrateKbps: 6000 } });
  assert.equal(res.json().bitrateKbps, 6000);
});

test("production mode never uses the simulated devices", async (t) => {
  const config = loadConfig({ PIGATEWAY_MODE: "production", PIGATEWAY_API_KEY: "k", PIGATEWAY_FREED_UDP_PORT: "0" });
  const built = await buildApp(config);
  const app = "app" in built ? built.app : built;
  await app.ready();
  t.after(() => app.close());
  await wait(100);
  const res = await app.inject({ method: "GET", url: "/api/v1/atem", headers: { authorization: "Bearer k" } });
  assert.equal(res.json().connected, false);
});
