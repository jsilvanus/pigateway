import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { AtemAdapter, type AtemClient } from "../src/atem/atem-adapter.js";

/** A client whose connect() never settles, as with an unreachable ATEM. */
class HangingAtem extends EventEmitter implements AtemClient {
  state: unknown = undefined;
  connect(): Promise<void> {
    return new Promise(() => undefined);
  }
  async disconnect(): Promise<void> {}
  async changeProgramInput(): Promise<void> {}
  async changePreviewInput(): Promise<void> {}
  async cut(): Promise<void> {}
}

test("a scheduled ATEM reconnect keeps the event loop alive", async () => {
  const fakes: HangingAtem[] = [];
  const adapter = new AtemAdapter({
    createClient: () => {
      const f = new HangingAtem();
      fakes.push(f);
      return f;
    },
    reconnectMinMs: 60_000,
  });
  void adapter.connect("192.0.2.1");
  await new Promise((r) => setImmediate(r));
  fakes[0]!.emit("disconnected");
  const timer = (adapter as unknown as { reconnectTimer: NodeJS.Timeout | null }).reconnectTimer;
  assert.ok(timer, "reconnect timer scheduled");
  assert.equal(timer.hasRef(), true, "reconnect timer must not be unref'd");
  await adapter.disconnect();
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

test("the gateway process keeps serving while the ATEM is unreachable", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    env: {
      ...process.env,
      PIGATEWAY_MODE: "simulation",
      PIGATEWAY_PORT: String(port),
      PIGATEWAY_AMX_TCP_PORT: "0",
      PIGATEWAY_ATEM_HOST: "192.0.2.1",
    },
    stdio: "ignore",
  });
  let exited: number | null | undefined;
  child.on("exit", (code) => {
    exited = code;
  });
  try {
    let ok = false;
    for (let i = 0; i < 40 && exited === undefined; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        ok = res.ok;
        if (ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(ok, `gateway did not come up (exit ${String(exited)})`);
    await new Promise((r) => setTimeout(r, 7000));
    assert.equal(exited, undefined, "process exited while the ATEM was down");
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.ok(res.ok);
  } finally {
    child.kill("SIGTERM");
  }
});
