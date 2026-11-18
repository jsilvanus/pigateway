import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { loadConfig } from "../src/config.ts";
import { createUiListeners } from "../src/ui/ui-setup.ts";

// Regression: the UI listeners were built after the main app was listening, and their close hook
// (addHook) then threw "addHook called after the server was already listening". Both listeners must start.
test("both UI listeners start on an app that is already listening", async () => {
  const app = Fastify({ logger: { level: "silent" } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const config = loadConfig({
    PIGATEWAY_UI_PORT: "3211",
    PIGATEWAY_UI_RELAY_PORT: "3212",
    PIGATEWAY_UI_PIN: "123456"
  });
  const listeners = createUiListeners(app, config);
  assert.deepEqual(listeners.map((l) => l.role).sort(), ["lan", "relay"]);
  try {
    for (const listener of listeners) {
      const address = await listener.app.listen({ host: listener.host, port: 0 });
      assert.match(String(address), /^http:\/\//);
    }
  } finally {
    await Promise.all(listeners.map((l) => l.app.close()));
    await app.close();
  }
});

test("a UI listener cannot be configured without a PIN, and the old no-PIN switch no longer opens the LAN", () => {
  assert.throws(() => loadConfig({ PIGATEWAY_UI_PORT: "3211" }), /PIGATEWAY_UI_PIN/);
  assert.throws(() => loadConfig({ PIGATEWAY_UI_PORT: "3211", PIGATEWAY_UI_LAN_NO_PIN: "true" }), /PIGATEWAY_UI_PIN/);
});

test("LAN listener built from config answers 401 without a session", async () => {
  const app = Fastify({ logger: { level: "silent" } });
  const config = loadConfig({ PIGATEWAY_UI_PORT: "3211", PIGATEWAY_UI_PIN: "225588" });
  const [lan] = createUiListeners(app, config);
  try {
    assert.equal((await lan!.app.inject({ method: "GET", url: "/api/v1/matrix" })).statusCode, 401);
    assert.equal((await lan!.app.inject({ method: "GET", url: "/ui/api/session" })).statusCode, 401);
  } finally {
    await lan!.app.close();
    await app.close();
  }
});
