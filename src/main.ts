import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createUiListeners } from "./ui/ui-setup.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.mode === "production" && !config.apiKey) {
    console.error("PIGATEWAY_API_KEY is required when PIGATEWAY_MODE=production");
    process.exitCode = 1;
    return;
  }
  const app = buildApp(config);

  // The gateway must outlive any device being down. This timer keeps the event loop alive until
  // shutdown, and the handlers below log how the process ended if it ever ends unexpectedly.
  const keepAlive = setInterval(() => undefined, 60_000);
  let shuttingDown = false;
  process.on("uncaughtException", (err) => {
    app.log.error({ event: "uncaught_exception", component: "lifecycle", err }, "Uncaught exception (process kept running)");
  });
  process.on("unhandledRejection", (reason) => {
    app.log.error({ err: reason }, "Unhandled promise rejection (process kept running)");
  });
  process.on("beforeExit", (code) => {
    if (!shuttingDown) app.log.error({ code }, "Event loop drained without a shutdown request");
  });
  process.on("exit", (code) => {
    if (!shuttingDown) console.error(`pigateway exiting with code ${code} without a shutdown request`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    shuttingDown = true;
    clearInterval(keepAlive);
    app.log.info({ event: "shutting_down", component: "lifecycle", reason: `signal ${signal}` }, "Shutting down pigateway");
    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, "Error while shutting down");
      process.exitCode = 1;
    }
    // A device library can leave a handle open (e.g. a pending ATEM connect); once everything is
    // closed, leave anyway after a short grace period. Unref'd: it only fires when something lingers.
    setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
  };
  process.once("SIGHUP", () => void shutdown("SIGHUP"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Built before listen: the close hook must be registered while the app is not yet listening.
  const uiListeners = createUiListeners(app, config);
  app.addHook("onClose", async () => {
    await Promise.all(uiListeners.map((listener) => listener.app.close()));
  });
  try {
    const address = await app.listen({ host: config.host, port: config.port });
    app.log.info({ address, mode: config.mode }, "pigateway listening");
    if (app.canvaTunnel && config.canvaTunnelPort !== undefined) {
      // Local only: the tunnel (ssh) is the way in, never the LAN.
      const tunnelAddress = await app.canvaTunnel.listen({ host: "127.0.0.1", port: config.canvaTunnelPort });
      app.log.info({ address: tunnelAddress }, "pigateway Canva listener");
    }
    for (const listener of uiListeners) {
      // The picontrol UI listeners: LAN (PIGATEWAY_UI_PORT) and relay on 127.0.0.1 (PIGATEWAY_UI_RELAY_PORT).
      const uiAddress = await listener.app.listen({ host: listener.host, port: listener.port });
      app.log.info({ address: uiAddress, role: listener.role }, "pigateway picontrol UI listener");
    }
    app.log.info(
      {
        event: "startup",
        component: "lifecycle",
        pid: process.pid,
        node: process.version,
        mode: config.mode,
        restartCount: process.env.NRESTARTS ?? null,
        // host:port only; secrets are reported as set/unset
        devices: {
          atem: config.atemHost ? `${config.atemHost}:${config.atemPort}` : null,
          amxMaster: config.amxMasterHost ?? null,
          encoder: config.encoderHost ?? null
        },
        apiKey: config.apiKey ? "set" : "unset"
      },
      "pigateway started"
    );
  } catch (error) {
    app.log.error({ err: error }, "Unable to start pigateway");
    shuttingDown = true;
    clearInterval(keepAlive);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("pigateway startup failed:", error);
  process.exitCode = 1;
});
