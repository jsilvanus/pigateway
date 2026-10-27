import Fastify, { type FastifyInstance } from "fastify";
import { createAmxClient } from "./amx/amx-client.js";
import { AmxTcpListener, tcpVideoForward, type AmxControl } from "./amx/amx-listener.js";
import { AtlonaMatrix } from "./amx/atlona.js";
import { AtemAdapter } from "./atem/atem-adapter.js";
import { registerAtemRoutes } from "./atem/atem-routes.js";
import { registerEncoderRoutes } from "./encoder/encoder-routes.js";
import { EncoderService } from "./encoder/encoder-service.js";
import { registerYoutubeRoutes } from "./youtube/youtube-routes.js";
import { YoutubeStatusStore } from "./youtube/youtube-status.js";
import type { PanTiltDirection, ZoomAction } from "./camera/visca-protocol.js";
import { registerCameraRoutes } from "./camera/camera-routes.js";
import { CameraService } from "./camera/camera-service.js";
import type { AppConfig } from "./config.js";
import { GatewayEventBroker } from "./events.js";
import { isIpWhitelisted } from "./ip-whitelist.js";

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-api-key"]
    }
  });

  // Every route as "METHOD /path/{param}", for the test that keeps openapi/openapi.json in step.
  const routeTable = new Set<string>();
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (method !== "HEAD" && method !== "OPTIONS") routeTable.add(`${method} ${route.url.replace(/:(\w+)/g, "{$1}")}`);
    }
  });
  (app as unknown as { routeTable: Set<string> }).routeTable = routeTable;

  const eventBroker = new GatewayEventBroker();

  const atem = new AtemAdapter({ logger: app.log });
  atem.onStateChange((state) => eventBroker.emit({ type: "atem", data: state }));
  registerAtemRoutes(app, atem);

  const encoder = new EncoderService({
    host: config.encoderHost,
    username: config.encoderUser,
    password: config.encoderPassword,
    https: config.encoderHttps,
    logger: app.log,
    onChange: (state) => eventBroker.emit({ type: "encoder", data: state })
  });
  registerEncoderRoutes(app, encoder);

  const youtube = new YoutubeStatusStore({ onChange: (record) => eventBroker.emit({ type: "youtube", data: record }) });
  registerYoutubeRoutes(app, youtube);

  const cameraService = new CameraService({
    mode: config.mode,
    eventBroker,
    logger: app.log,
    nearLimitM: config.cameraNearLimitM,
    cam1Name: config.cam1Name,
    cam1Host: config.cam1Host,
    cam1ViscaPort: config.cam1ViscaPort,
    cam1CgiPort: config.cam1CgiPort,
    cam1CgiUser: config.cam1CgiUser,
    cam1CgiPassword: config.cam1CgiPassword,
    cam2Name: config.cam2Name,
    cam2Host: config.cam2Host,
    cam2ViscaPort: config.cam2ViscaPort,
    cam2CgiPort: config.cam2CgiPort,
    cam2CgiUser: config.cam2CgiUser,
    cam2CgiPassword: config.cam2CgiPassword,
    mediaMtxRtspBaseUrl: config.mediaMtxRtspUrl,
    mediaMtxRtmpBaseUrl: config.mediaMtxRtmpUrl
  });

  // VISCA power is not read back, so "unknown" until AMX or the API sets it.
  const cameraPower = new Map<string, "on" | "standby">();
  registerCameraRoutes(app, cameraService, {
    onPower: (id, on) => cameraPower.set(id, on ? "on" : "standby")
  });
  const amxClient = createAmxClient(config.amxSimulated, config.amxMasterHost, config.amxMasterPort, app.log);
  const matrix = new AtlonaMatrix(amxClient, eventBroker, app.log);
  matrix.register(app, config.mode);

  const amxControl: AmxControl = {
    cameras: () =>
      cameraService.list().map((cam) => ({ id: cam.id, connection: cam.connection, power: cameraPower.get(cam.id) ?? "unknown" })),
    cameraPower: async (id, on) => {
      await cameraService.setPower(id, on);
      cameraPower.set(id, on ? "on" : "standby");
    },
    cameraPreset: async (id, presetId, save) => {
      await (save ? cameraService.savePreset(id, presetId) : cameraService.recallPreset(id, presetId));
    },
    cameraMove: async (id, direction) => {
      await cameraService.move(id, direction as PanTiltDirection);
    },
    cameraZoom: async (id, action) => {
      await cameraService.zoom(id, action as ZoomAction);
    },
    atlonaRoutes: () => ({ ...matrix.state.routes })
  };
  const amxListener = config.amxTcpEnabled
    ? new AmxTcpListener({
        control: amxControl,
        forward: config.videoAmxHost ? tcpVideoForward(config.videoAmxHost, config.videoAmxPort) : undefined,
        host: config.amxTcpHost,
        port: config.amxTcpPort,
        mode: config.mode,
        logger: app.log,
        allowedIps: config.amxAllowedHosts
      })
    : null;
  (app as unknown as { amxListener?: AmxTcpListener | null }).amxListener = amxListener;

  app.addHook("onReady", async () => {
    if (amxListener) await amxListener.start();
    if (config.amxMasterHost) matrix.startPolling();
    encoder.start();
    if (config.atemHost) {
      await atem.connect(config.atemHost, config.atemPort).catch((error: unknown) => {
        app.log.warn({ err: error }, "ATEM connect failed; the adapter keeps retrying");
      });
    }
  });
  app.addHook("onClose", async () => {
    matrix.stopPolling();
    encoder.stop();
    youtube.stop();
    await Promise.allSettled([
      atem.disconnect(),
      cameraService.close(),
      amxListener ? amxListener.stop() : Promise.resolve(),
      amxClient.close()
    ]);
  });

  // CORS for /api/v1, only for origins in PIGATEWAY_CORS_ORIGINS. Preflights are answered before routing.
  const corsAllowed = new Set(config.corsOrigins ?? []);
  const corsOriginFor = (origin: string | undefined): string | null =>
    origin && corsAllowed.has(origin) ? origin : null;
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "OPTIONS" || !request.url.startsWith("/api/v1/")) return;
    const allowed = corsOriginFor(request.headers.origin);
    if (!allowed) return;
    return reply
      .code(204)
      .header("Access-Control-Allow-Origin", allowed)
      .header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
      .header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key")
      .header("Access-Control-Max-Age", "600")
      .header("Vary", "Origin")
      .send();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/api/v1/") || reply.hasHeader("Access-Control-Allow-Origin")) return payload;
    const allowed = corsOriginFor(request.headers.origin);
    reply.header("Vary", "Origin");
    if (allowed) reply.header("Access-Control-Allow-Origin", allowed);
    return payload;
  });

  // Writes under /api/v1 need the API key unless the client is on the allowed list.
  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (!(request.url.split("?")[0] ?? "").startsWith("/api/v1/")) return;
    if (isIpWhitelisted(request.ip, config.authAllowedHosts)) return;
    if (!config.apiKey) return;
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ")
      ? header.slice(7).trim()
      : typeof request.headers["x-api-key"] === "string"
        ? request.headers["x-api-key"].trim()
        : undefined;
    if (token !== config.apiKey) {
      return reply.status(401).send({
        statusCode: 401,
        error: "Unauthorized",
        message: "Valid API key or Bearer token required for control operations"
      });
    }
  });

  app.get("/health", async () => ({ status: "ok", service: "pigateway" }));

  app.get("/api/v1/status", async () => ({
    service: "pigateway",
    mode: config.mode,
    atem: { configured: Boolean(config.atemHost), connected: atem.getState().connected },
    youtube: { state: youtube.get().state },
    encoder: { configured: encoder.getState().configured, connected: encoder.getState().connected },
    cameras: cameraService.list().map((cam) => ({ id: cam.id, connection: cam.connection }))
  }));

  app.get("/api/v1/events", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.write(
      `event: ready\ndata: ${JSON.stringify({ status: "connected", time: new Date().toISOString() })}\n\n`
    );
    const unsubscribe = eventBroker.subscribe((event) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      } catch {
        // socket closed
      }
    });
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": keep-alive\n\n");
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 15000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
