import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { AtemAdapter, type AtemClient } from "../src/atem/atem-adapter.js";
import { registerAtemRoutes } from "../src/atem/atem-routes.js";

function fakeClient(): AtemClient & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  const state = {
    video: {
      mixEffects: [
        {
          programInput: 1,
          previewInput: 2,
          transitionPosition: { inTransition: false, remainingFrames: 0 },
          fadeToBlack: { isFullyBlack: false, inTransition: false, remainingFrames: 0 },
        },
      ],
      downstreamKeyers: [
        { onAir: false, inTransition: false, properties: { tie: true } },
        { onAir: true, inTransition: false, properties: { tie: false } },
      ],
    },
  };
  return {
    calls,
    state,
    async connect() {
      listeners.get("connected")?.();
    },
    async disconnect() {},
    async changeProgramInput(...args: unknown[]) { calls.push(["program", ...args]); },
    async changePreviewInput(...args: unknown[]) { calls.push(["preview", ...args]); },
    async cut(...args: unknown[]) { calls.push(["cut", ...args]); },
    async autoTransition(...args: unknown[]) { calls.push(["auto", ...args]); },
    async fadeToBlack(...args: unknown[]) { calls.push(["ftb", ...args]); },
    async setDownstreamKeyTie(...args: unknown[]) { calls.push(["tie", ...args]); },
    async setDownstreamKeyOnAir(...args: unknown[]) { calls.push(["onair", ...args]); },
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, listener);
      return this;
    },
  } as unknown as AtemClient & { calls: unknown[][] };
}

async function build(client: AtemClient | null) {
  const atem = new AtemAdapter({ createClient: () => client ?? fakeClient() });
  const app = Fastify();
  registerAtemRoutes(app, atem);
  if (client) await atem.connect("192.0.2.10");
  return { app, atem };
}

test("GET /api/v1/atem reports disconnected when no ATEM is configured", async () => {
  const { app } = await build(null);
  const res = await app.inject({ method: "GET", url: "/api/v1/atem" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().connected, false);
  await app.close();
});

test("PUT program and preview switch the ATEM and return state", async () => {
  const client = fakeClient();
  const { app } = await build(client);
  const program = await app.inject({ method: "PUT", url: "/api/v1/atem/program", payload: { input: 3 } });
  assert.equal(program.statusCode, 200);
  assert.deepEqual(client.calls[0], ["program", 3, 0]);
  const preview = await app.inject({ method: "PUT", url: "/api/v1/atem/preview", payload: { input: 4 } });
  assert.equal(preview.statusCode, 200);
  assert.deepEqual(client.calls[1], ["preview", 4, 0]);
  await app.close();
});

test("cut sends a cut on the M/E row", async () => {
  const client = fakeClient();
  const { app } = await build(client);
  const res = await app.inject({ method: "POST", url: "/api/v1/atem/cut" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(client.calls[0], ["cut", 0]);
  await app.close();
});

test("invalid input is rejected with 422 and nothing is sent", async () => {
  const client = fakeClient();
  const { app } = await build(client);
  for (const input of [0, -1, 1.5, "x", 99]) {
    const res = await app.inject({ method: "PUT", url: "/api/v1/atem/program", payload: { input } });
    assert.equal(res.statusCode, 422, `input ${String(input)}`);
  }
  assert.equal(client.calls.length, 0);
  await app.close();
});

test("writes answer 503 when the ATEM is not connected", async () => {
  const { app } = await build(null);
  const res = await app.inject({ method: "PUT", url: "/api/v1/atem/program", payload: { input: 1 } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "ATEM_NOT_CONNECTED");
  const cut = await app.inject({ method: "POST", url: "/api/v1/atem/cut" });
  assert.equal(cut.statusCode, 503);
  await app.close();
});

test("state reports fade to black and the downstream keyers", async () => {
  const { app } = await build(fakeClient());
  const res = await app.inject({ method: "GET", url: "/api/v1/atem" });
  const body = res.json();
  assert.deepEqual(body.fadeToBlack, { fullyBlack: false, inTransition: false, remainingFrames: 0 });
  assert.deepEqual(body.downstreamKeyers, [
    { dsk: 1, onAir: false, tie: true, inTransition: false },
    { dsk: 2, onAir: true, tie: false, inTransition: false },
  ]);
  await app.close();
});

test("auto and ftb act on the M/E row", async () => {
  const client = fakeClient();
  const { app } = await build(client);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/atem/auto" })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/atem/ftb" })).statusCode, 200);
  assert.deepEqual(client.calls, [["auto", 0], ["ftb", 0]]);
  await app.close();
});

test("dsk on-air and tie use the zero-based keyer and validate the body", async () => {
  const client = fakeClient();
  const { app } = await build(client);
  const onAir = await app.inject({ method: "PUT", url: "/api/v1/atem/dsk/2/on-air", payload: { onAir: true } });
  assert.equal(onAir.statusCode, 200);
  const tie = await app.inject({ method: "PUT", url: "/api/v1/atem/dsk/1/tie", payload: { tie: false } });
  assert.equal(tie.statusCode, 200);
  assert.deepEqual(client.calls, [["onair", true, 1], ["tie", false, 0]]);
  const bad = await app.inject({ method: "PUT", url: "/api/v1/atem/dsk/9/tie", payload: { tie: true } });
  assert.equal(bad.statusCode, 422);
  const badBody = await app.inject({ method: "PUT", url: "/api/v1/atem/dsk/1/on-air", payload: { onAir: "yes" } });
  assert.equal(badBody.statusCode, 422);
  await app.close();
});

test("new ATEM routes answer 503 when no ATEM is connected", async () => {
  const { app } = await build(null);
  for (const [method, url, payload] of [
    ["POST", "/api/v1/atem/auto", undefined],
    ["POST", "/api/v1/atem/ftb", undefined],
    ["PUT", "/api/v1/atem/dsk/1/on-air", { onAir: true }],
    ["PUT", "/api/v1/atem/dsk/1/tie", { tie: true }],
  ] as const) {
    const res = await app.inject({ method, url, payload });
    assert.equal(res.statusCode, 503, url);
  }
  await app.close();
});
