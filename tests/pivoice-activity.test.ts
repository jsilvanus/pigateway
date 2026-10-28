import assert from "node:assert/strict";
import test from "node:test";
import { PiVoiceActivityCoordinator } from "../src/pivoice/activity-coordinator.js";
import type { PiVoiceTelemetry } from "../src/pivoice/telemetry.js";

function telemetry(classification: PiVoiceTelemetry["classification"]): PiVoiceTelemetry {
  return {
    connected: true, stale: false, lastSeenAt: new Date().toISOString(), lastPollAt: null,
    sequence: 1, timestampMs: Date.now(), rmsDbfs: -30, peakDbfs: -10, classification,
    confidence: 90, capture: { state: "running", sampleFormat: "S16LE", channels: 1, sampleRateHz: 16000 },
    publisher: "publishing"
  };
}

test("gateway opens on activity and closes after a single idle timeout", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const coordinator = new PiVoiceActivityCoordinator({
    baseUrl: "http://pivoice:8095",
    token: "test-token",
    idleCloseSeconds: 1,
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    }
  });
  coordinator.observe(telemetry("speech"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(coordinator.getState().session, "open");
  coordinator.observe(telemetry("silence"));
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert.equal(coordinator.getState().session, "closed");
  assert.deepEqual(calls.map((call) => call.url), [
    "http://pivoice:8095/api/v1/activity/session/start",
    "http://pivoice:8095/api/v1/activity/session/stop"
  ]);
  assert.equal(JSON.parse(calls[0].body).trigger, "speech");
  assert.equal(JSON.parse(calls[1].body).reason, "idle-timeout");
});

test("zero idle timeout leaves an activity session open", async () => {
  const coordinator = new PiVoiceActivityCoordinator({
    baseUrl: "http://pivoice:8095", idleCloseSeconds: 0,
    fetchFn: async () => new Response("{}", { status: 200 })
  });
  coordinator.observe(telemetry("music"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  coordinator.observe(telemetry("silence"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(coordinator.getState().session, "open");
  await coordinator.close();
});
