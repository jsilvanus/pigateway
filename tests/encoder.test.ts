import assert from "node:assert/strict";
import test from "node:test";
import { MonarchBusyError, MonarchCommandError, MonarchConnectionError } from "@jsilvanus/matrox-monarch-control";
import Fastify from "fastify";
import { loadConfig } from "../src/config.js";
import { registerEncoderRoutes } from "../src/encoder/encoder-routes.js";
import { EncoderService, type MonarchDevice } from "../src/encoder/encoder-service.js";

function fakeDevice(over: Partial<MonarchDevice> = {}): MonarchDevice & { calls: string[] } {
  const calls: string[] = [];
  let state = "READY";
  const record = (name: string) => async () => { calls.push(name); return {}; };
  return {
    calls,
    async getStatus() {
      return { encoder1: { mode: "RTMP", state }, encoder2: { mode: "RECORD", state: "READY" }, name: "Kirkko" } as never;
    },
    async startEncoder(n) { calls.push(`start${n}`); state = "ON"; return {}; },
    async stopEncoder(n) { calls.push(`stop${n}`); state = "READY"; return {}; },
    startBothEncoders: record("startBoth"),
    stopBothEncoders: record("stopBoth"),
    async getInputStatus() { return { input: "SDI A", resolution: "1920x1080i", framerate: 25 } as never; },
    async getVideoInput() { return "SDI"; },
    setVideoInput: record("setVideo"),
    async getAudioInput() { return "DIGITAL"; },
    setAudioInput: record("setAudio"),
    async getStreamingVideoDataRate() { return 4000; },
    setStreamingVideoDataRate: record("setRate"),
    async getRecordFileName() { return "sermon"; },
    setRecordFileName: record("setName"),
    async getEncoderRTMP() { return { url: "rtmp://pi/live", streamName: "SECRET-KEY", username: "u" }; },
    setEncoderRTMP: record("setRtmp"),
    ...over
  };
}

async function build(device: MonarchDevice, events: unknown[] = []) {
  const encoder = new EncoderService({ device, busyDelayMs: 1, onChange: (s) => events.push(s) });
  const app = Fastify();
  registerEncoderRoutes(app, encoder);
  await app.ready();
  return { app, encoder };
}

test("state is unconfigured without a host and writes answer 503", async () => {
  const app = Fastify();
  registerEncoderRoutes(app, new EncoderService({}));
  const state = (await app.inject({ method: "GET", url: "/api/v1/encoder" })).json();
  assert.equal(state.configured, false);
  const res = await app.inject({ method: "POST", url: "/api/v1/encoder/start", payload: {} });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, "ENCODER_NOT_CONFIGURED");
});

test("start and stop pick the right command and publish the change", async () => {
  const device = fakeDevice();
  const events: unknown[] = [];
  const { app } = await build(device, events);
  let res = await app.inject({ method: "POST", url: "/api/v1/encoder/start", payload: { encoder: 1 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().encoder1.state, "ON");
  assert.equal(res.json().connected, true);
  await app.inject({ method: "POST", url: "/api/v1/encoder/stop", payload: { encoder: 1 } });
  await app.inject({ method: "POST", url: "/api/v1/encoder/start" });
  await app.inject({ method: "POST", url: "/api/v1/encoder/stop", payload: { encoder: "both" } });
  assert.deepEqual(device.calls, ["start1", "stop1", "startBoth", "stopBoth"]);
  assert.ok(events.length >= 2);
  res = await app.inject({ method: "POST", url: "/api/v1/encoder/start", payload: { encoder: 3 } });
  assert.equal(res.statusCode, 422);
});

test("a busy answer is retried, calls never overlap", async () => {
  let busy = 2;
  let active = 0;
  let maxActive = 0;
  const device = fakeDevice({
    async getInputStatus() {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (busy-- > 0) throw new MonarchBusyError("busy", "GetInputStatus", "RETRY");
      return { input: "SDI A", resolution: "1080i", framerate: 25 } as never;
    }
  });
  const { app } = await build(device);
  const [a, b] = await Promise.all([
    app.inject({ method: "GET", url: "/api/v1/encoder/input" }),
    app.inject({ method: "GET", url: "/api/v1/encoder/input" })
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(maxActive, 1);
});

test("device refusals and connection errors map to 409 and 502", async () => {
  const { app } = await build(fakeDevice({
    async setVideoInput() { throw new MonarchCommandError("FAILED", "SetVideoInput=HDMI", "FAILED"); },
    async getVideoInput() { throw new MonarchConnectionError("down", "GetVideoInput"); }
  }));
  const refused = await app.inject({ method: "PUT", url: "/api/v1/encoder/settings", payload: { videoInput: "HDMI" } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().error.code, "ENCODER_REFUSED");
  const down = await app.inject({ method: "GET", url: "/api/v1/encoder/settings" });
  assert.equal(down.statusCode, 502);
});

test("settings are validated, applied and never show the stream key", async () => {
  const device = fakeDevice();
  const { app } = await build(device);
  for (const payload of [{}, { videoInput: "VGA" }, { bitrateKbps: 0 }, { recordFileName: "a/b" }]) {
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/encoder/settings", payload })).statusCode, 422);
  }
  const res = await app.inject({ method: "PUT", url: "/api/v1/encoder/settings", payload: { bitrateKbps: 5000, recordFileName: "x" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(device.calls, ["setRate", "setName"]);
  assert.equal(res.json().bitrateKbps, 4000);
  assert.ok(!res.body.includes("SECRET-KEY"));
});

test("RTMP target is validated and set", async () => {
  const device = fakeDevice();
  const { app } = await build(device);
  const url = "/api/v1/encoder/1/rtmp";
  assert.equal((await app.inject({ method: "PUT", url, payload: { url: "http://x", streamName: "k" } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url, payload: { url: "rtmp://pi/live", streamName: "a;b" } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/encoder/3/rtmp", payload: { url: "rtmp://pi/live", streamName: "k" } })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url, payload: { url: "rtmp://pi/live", streamName: "k" } })).statusCode, 204);
  assert.deepEqual(device.calls, ["setRtmp"]);
});

test("config reads the encoder and wants user and password together", () => {
  const c = loadConfig({ PIGATEWAY_ENCODER_HOST: "10.0.0.5", PIGATEWAY_ENCODER_USER: "a", PIGATEWAY_ENCODER_PASSWORD: "b" });
  assert.equal(c.encoderHost, "10.0.0.5");
  assert.equal(c.encoderUser, "a");
  assert.throws(() => loadConfig({ PIGATEWAY_ENCODER_USER: "a" }), /together/);
});
