import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

test("the gateway still starts and serves when the AMX listener port is taken", async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const taken = (blocker.address() as { port: number }).port;
  const app = buildApp(
    loadConfig({
      PIGATEWAY_MODE: "simulation",
      PIGATEWAY_AMX_TCP_HOST: "127.0.0.1",
      PIGATEWAY_AMX_TCP_PORT: String(taken)
    })
  );
  try {
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("the gateway starts with the AMX master and encoder unreachable", async () => {
  const app = buildApp(
    loadConfig({
      PIGATEWAY_MODE: "simulation",
      PIGATEWAY_AMX_TCP_PORT: "0",
      PIGATEWAY_AMX_MASTER_HOST: "192.0.2.2",
      PIGATEWAY_ENCODER_HOST: "192.0.2.3"
    })
  );
  try {
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
  } finally {
    await app.close();
  }
});
