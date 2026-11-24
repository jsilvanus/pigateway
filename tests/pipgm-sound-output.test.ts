import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { GatewayEventBroker } from "../src/events.js";
import { PiMatrixClient } from "../src/matrix/client.js";
import { PiProgramClient } from "../src/pipgm/client.js";
import { registerPiPgmRoutes } from "../src/pipgm/pipgm-routes.js";
import { SoundOutputForwarder } from "../src/pipgm/sound-output-forwarder.js";

type Seen = { method: string; path: string; body: unknown };

function setup(hdmi: string | null | "fail") {
  const seen: Seen[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const pimatrixFetch: typeof fetch = async () => (hdmi === "fail" ? json({ error: { message: "no" } }, 502) : json({ hdmi }));
  const piprogramFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return json({ ok: true });
  };
  const broker = new GatewayEventBroker();
  const forwarder = new SoundOutputForwarder({
    pimatrix: new PiMatrixClient({ baseUrl: "http://pimatrix", fetchFn: pimatrixFetch }),
    piprogram: new PiProgramClient({ baseUrl: "http://piprogram", token: "k", fetchFn: piprogramFetch }),
    eventBroker: broker,
    debounceMs: 5,
    intervalMs: 60_000
  });
  return { seen, broker, forwarder, piprogramFetch };
}

test("the forwarder is off until enabled and sends nothing", async () => {
  const { seen, broker, forwarder } = setup("hdmi0");
  broker.emit({ type: "matrix", data: { locked: false, routes: {} } } as never);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 0);
  assert.equal(forwarder.status().enabled, false);
});

test("enabling reports pimatrix's HDMI to piprogram at once and again after a matrix change", async () => {
  const { seen, broker, forwarder } = setup("hdmi1");
  forwarder.setEnabled(true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen.at(-1), { method: "PUT", path: "/api/v1/pipgm/audio/sound-output", body: { output: "hdmi1", source: "pigateway" } });
  const before = seen.length;
  broker.emit({ type: "matrix", data: { locked: false, routes: { 1: 3 } } } as never);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(seen.length, before + 1);
  assert.equal(forwarder.status().lastOutput, "hdmi1");
  forwarder.stop();
});

test("a source that is not a Pi output is reported as null; a pimatrix failure reports nothing", async () => {
  const none = setup(null);
  none.forwarder.setEnabled(true);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual((none.seen.at(-1) as Seen).body, { output: null, source: "pigateway" });
  none.forwarder.stop();

  const bad = setup("fail");
  bad.forwarder.setEnabled(true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(bad.seen.length, 0);
  assert.match(bad.forwarder.status().lastError ?? "", /no/);
  bad.forwarder.stop();
});

test("runtime routes pass through and the forwarding switch validates its body", async () => {
  const { seen, forwarder, piprogramFetch } = setup("hdmi0");
  const app = Fastify();
  registerPiPgmRoutes(app, { client: new PiProgramClient({ baseUrl: "http://piprogram", token: "k", fetchFn: piprogramFetch }), soundForwarder: forwarder });
  const calls: Array<[string, string, unknown?]> = [
    ["GET", "/api/v1/pipgm/publish"],
    ["PUT", "/api/v1/pipgm/publish", { enabled: true, rtspBase: "rtsp://127.0.0.1:8554" }],
    ["PUT", "/api/v1/pipgm/local-audio", { devices: { hdmi0: "hdmi:CARD=vc4hdmi0,DEV=0" } }],
    ["PUT", "/api/v1/pipgm/audio/sound-output", { output: "hdmi0" }],
    ["POST", "/api/v1/pipgm/audio/speak", { itemId: "t1", level: "whisper", dryRun: true }],
    ["POST", "/api/v1/pipgm/audio/speak/stop"]
  ];
  for (const [method, url, payload] of calls) {
    const res = await app.inject({ method: method as "GET", url, ...(payload ? { payload: payload as object } : {}) });
    assert.equal(res.statusCode, 200, `${method} ${url}`);
  }
  assert.deepEqual(seen.map((s) => `${s.method} ${s.path}`), calls.map(([m, u]) => `${m} ${u}`));
  assert.deepEqual(seen[4]?.body, { itemId: "t1", level: "whisper", dryRun: true });

  const bad = await app.inject({ method: "PUT", url: "/api/v1/pipgm/audio/sound-output/forwarding", payload: { enabled: "yes" } });
  assert.equal(bad.statusCode, 422);
  const off = await app.inject({ method: "GET", url: "/api/v1/pipgm/audio/sound-output/forwarding" });
  assert.equal(off.json().enabled, false);
  forwarder.stop();
  await app.close();
});
