import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.mode === "production" && !config.apiKey) {
    console.error("PIGATEWAY_API_KEY is required when PIGATEWAY_MODE=production");
    process.exitCode = 1;
    return;
  }
  const app = buildApp(config);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "Shutting down pigateway");
    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, "Error while shutting down");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const address = await app.listen({ host: config.host, port: config.port });
    app.log.info({ address, mode: config.mode }, "pigateway listening");
  } catch (error) {
    app.log.error({ err: error }, "Unable to start pigateway");
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("pigateway startup failed:", error);
  process.exitCode = 1;
});
