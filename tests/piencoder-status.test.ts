import assert from "node:assert/strict";
import test from "node:test";
import { PiencoderStatus } from "../src/encoder/piencoder-status.js";

const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

test("reports piencoder's state from the primary unit", async () => {
  const s = new PiencoderStatus({
    url: "http://pi:3300/",
    fetchFn: ok({ id: 1, items: [{ id: 1, name: "Monarch", configured: true, connected: true, encoder1: { mode: "RTMP", state: "READY" }, encoder2: { mode: "RECORD", state: "READY" } }] })
  });
  const st = await s.refresh(true);
  assert.equal(st.configured, true);
  assert.equal(st.connected, true);
  assert.equal(st.encoder1.mode, "RTMP");
  assert.equal(st.error, undefined);
});

test("piencoder down: configured but not connected, with error", async () => {
  const s = new PiencoderStatus({ url: "http://pi:3300", fetchFn: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
  const st = await s.refresh(true);
  assert.equal(st.configured, true);
  assert.equal(st.connected, false);
  assert.match(st.error ?? "", /ECONNREFUSED/);
});

test("caches within ttl", async () => {
  let calls = 0; let t = 0;
  const s = new PiencoderStatus({ url: "http://x", now: () => t, ttlMs: 2000, fetchFn: (async () => { calls++; return new Response(JSON.stringify({ connected: true })); }) as typeof fetch });
  await s.refresh(); await s.refresh(); t = 3000; await s.refresh();
  assert.equal(calls, 2);
});

test("accepts the packed status string older piencoder builds send", async () => {
  const s = new PiencoderStatus({
    url: "http://pi:3300",
    fetchFn: ok({ id: 1, connected: true, encoder1: { mode: "ENC1:RTMP,ON,ENC2:RECORD,READY,NAME:MonarchHDX" }, encoder2: {}, items: [] })
  });
  const st = await s.refresh(true);
  assert.deepEqual(st.encoder1, { mode: "RTMP", state: "ON" });
  assert.deepEqual(st.encoder2, { mode: "RECORD", state: "READY" });
});
