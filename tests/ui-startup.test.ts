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
    PIGATEWAY_UI_PIN: "123456",
    PIGATEWAY_UI_LAN_NO_PIN: "true"
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
