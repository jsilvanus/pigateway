import Fastify, { type FastifyInstance } from "fastify";
import { createAmxClient } from "./amx/amx-client.js";
import { AmxTcpListener, tcpVideoForward, type AmxControl } from "./amx/amx-listener.js";
import { AtlonaMatrix } from "./amx/atlona.js";
import { registerProjectorRoutes } from "./amx/projector-routes.js";
import { AtemAdapter } from "./atem/atem-adapter.js";
import { registerAtemRoutes } from "./atem/atem-routes.js";
import { registerEncoderRoutes } from "./encoder/encoder-routes.js";
import { EncoderService } from "./encoder/encoder-service.js";
import { registerYoutubeRoutes } from "./youtube/youtube-routes.js";
import { YoutubeStatusStore } from "./youtube/youtube-status.js";
import type { PanTiltDirection, ZoomAction } from "./camera/visca-protocol.js";
import { registerCameraRoutes } from "./camera/camera-routes.js";
import { CameraService } from "./camera/camera-service.js";
import { FreedUdpReceiver } from "./camera/freed-receiver.js";
import type { AppConfig } from "./config.js";
import { GatewayEventBroker, type GatewayEvent } from "./events.js";
import { isIpWhitelisted } from "./ip-whitelist.js";
import { PiVoiceUdpReceiver } from "./pivoice/telemetry.js";
import { PiSoundUdpReceiver } from "./pisound/telemetry.js";
import { PiVoiceActivityCoordinator } from "./pivoice/activity-coordinator.js";
import { RadioRelayClient } from "./radio-relay/radio-relay-client.js";
import { AuditorSseSource } from "./transcripts/auditor-sse-source.js";
import { TranscriptHub, transcriptId } from "./transcripts/transcript-hub.js";
import { EcosystemTracker } from "./ecosystem/ecosystem-tracker.js";
import { ActionRegistry } from "./actions/action-registry.js";
import { registerActionRoutes } from "./actions/action-routes.js";

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
  (app as unknown as { eventBroker: GatewayEventBroker }).eventBroker = eventBroker;
  const transcripts = new TranscriptHub({
    capacity: config.transcriptBuffer,
    onTranscript: (event) => eventBroker.emit({ type: "transcript", data: event })
  });
  const auditorSse = new AuditorSseSource({ baseUrl: config.auditorUrl, apiKey: config.auditorApiKey, hub: transcripts, logger: app.log });
  const transcriptDelivery =
    config.transcriptDelivery === "push" && config.transcriptPushUrl
      ? ({ mode: "push", url: config.transcriptPushUrl, token: config.transcriptPushToken } as const)
      : config.transcriptDelivery === "sse" && auditorSse.configured()
        ? ({ mode: "sse" } as const)
        : undefined;
  const pivoiceActivity = new PiVoiceActivityCoordinator({
    baseUrl: config.pivoiceApiUrl,
    token: config.pivoiceApiToken,
    idleCloseSeconds: config.pivoiceIdleCloseSeconds,
    startWhen: config.pivoiceStartWhen,
    logger: app.log,
    delivery: transcriptDelivery,
    onSession: (sessionId) => (sessionId && transcriptDelivery?.mode === "sse" ? auditorSse.start(sessionId) : auditorSse.stop()),
    onChange: (state) => eventBroker.emit({ type: "pivoice-activity", data: state })
  });
  const radioRelay = new RadioRelayClient({ baseUrl: config.radioRelayApiUrl, token: config.radioRelayApiToken, streamName: config.radioRelayStreamName, logger: app.log });
  const pivoice = new PiVoiceUdpReceiver({
    host: config.pivoiceUdpHost ?? "0.0.0.0",
    port: config.pivoiceUdpPort ?? 3101,
    allowedIps: config.pivoiceAllowedHosts,
    logger: app.log,
    onChange: (state) => {
      eventBroker.emit({ type: "pivoice", data: state });
      pivoiceActivity.observe(state);
    }
  });

  const pisound = new PiSoundUdpReceiver({
    host: config.pisoundUdpHost ?? "0.0.0.0",
    port: config.pisoundUdpPort ?? 3102,
    allowedIps: config.pisoundAllowedHosts,
    logger: app.log,
    onChange: (state) => {
      eventBroker.emit({ type: "pisound", data: state });
    }
  });

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

  const freedReceiver = config.freedUdpEnabled
    ? new FreedUdpReceiver({
        host: config.freedUdpHost,
        port: config.freedUdpPort,
        allowedIps: config.freedAllowedHosts,
        eventBroker,
        logger: app.log
      })
    : undefined;

  // VISCA power is not read back, so "unknown" until AMX or the API sets it.
  const cameraPower = new Map<string, "on" | "standby">();
  registerCameraRoutes(app, cameraService, freedReceiver, {
    onPower: (id, on) => cameraPower.set(id, on ? "on" : "standby")
  });
  const amxClient = createAmxClient(config.amxSimulated, config.amxMasterHost, config.amxMasterPort, app.log);
  const matrix = new AtlonaMatrix(amxClient, eventBroker, app.log);
  matrix.register(app, config.mode);
  registerProjectorRoutes(app, amxClient);

  const ecosystemTracker = new EcosystemTracker({
    config,
    logger: app.log,
    eventBroker,
    pisoundReceiver: pisound,
    pivoiceReceiver: pivoice,
    youtubeStatus: youtube,
    atemAdapter: atem,
    encoderService: encoder,
    cameraService,
    onPisoundActivate: async () => {
      app.log.info({ port: config.pisoundUdpPort }, "PiSound detected active; starting UDP telemetry receiver");
      await pisound.start().catch((error: unknown) => {
        app.log.error({ err: error, port: config.pisoundUdpPort }, "Unable to start PiSound UDP telemetry receiver");
      });
      ecosystemTracker.markPisoundReceiverStarted();
    }
  });

  const actionRegistry = new ActionRegistry({
    config,
    atem,
    cameraService,
    encoder,
    matrix,
    ecosystemTracker,
    eventBroker,
  });
  registerActionRoutes(app, actionRegistry);

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
    atlonaRoutes: () => ({ ...matrix.state.routes }),
    atemState: () => {
      const s = atem.getState();
      return {
        connected: s.connected,
        programInput: s.programInput,
        previewInput: s.previewInput,
        ...(s.fadeToBlack ? { fadeToBlack: { isFullyBlack: s.fadeToBlack.fullyBlack, inTransition: s.fadeToBlack.inTransition } } : {}),
        downstreamKeyers: s.downstreamKeyers?.map((k) => ({ dsk: k.dsk, onAir: k.onAir, tie: k.tie }))
      };
    },
    encoderState: () => encoder.getState(),
    atemPreview: async (input) => { await atem.setPreview(input); },
    atemCut: async () => { await atem.cut(); },
    atemAuto: async () => { await atem.autoTransition(); },
    atemFtb: async () => { await atem.fadeToBlack(); },
    atemDskTie: async (dsk, tie) => { await atem.setDownstreamKeyTie(dsk - 1, tie); },
    atemDskOnAir: async (dsk, onAir) => { await atem.setDownstreamKeyOnAir(dsk - 1, onAir); },
    encoderAction: async (target, action) => {
      if (action === "start") await encoder.startEncoder(target);
      else await encoder.stopEncoder(target);
    }
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
    const pisoundShouldStart = await ecosystemTracker.shouldStartPisoundReceiver();
    if (pisoundShouldStart) {
      await pisound.start().catch((error: unknown) => {
        app.log.error({ err: error, port: config.pisoundUdpPort }, "Unable to start PiSound UDP telemetry receiver");
      });
      ecosystemTracker.markPisoundReceiverStarted();
    } else {
      app.log.info({ port: config.pisoundUdpPort }, "PiSound is not active; skipping UDP telemetry receiver startup");
    }
    if (config.pivoiceEnabled !== false) {
      await pivoice.start().catch((error: unknown) => {
        app.log.error({ err: error, port: config.pivoiceUdpPort }, "Unable to start PiVoice UDP telemetry receiver");
      });
    }
    ecosystemTracker.start();
    if (amxListener) await amxListener.start();
    if (config.amxMasterHost) matrix.startPolling();
    encoder.start();
    if (freedReceiver) {
      await freedReceiver.start().catch((err: unknown) => {
        app.log.warn({ err }, "FreeD UDP receiver failed to start; tracking telemetry disabled");
      });
    }
    if (config.atemHost) {
      await atem.connect(config.atemHost, config.atemPort).catch((error: unknown) => {
        app.log.warn({ err: error }, "ATEM connect failed; the adapter keeps retrying");
      });
    }
  });
  app.addHook("onClose", async () => {
    ecosystemTracker.stop();
    auditorSse.stop();
    matrix.stopPolling();
    encoder.stop();
    youtube.stop();
    await Promise.allSettled([
      pivoice.stop(),
      pisound.stop(),
      pivoiceActivity.close(),
      atem.disconnect(),
      cameraService.close(),
      freedReceiver ? freedReceiver.stop() : Promise.resolve(),
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

  app.get("/api/v1/sound", async () => pisound.getState());

  app.get("/health", async () => ({ status: "ok", service: "pigateway" }));

  app.get("/api/v1/status", async () => {
    const eco = ecosystemTracker.getSummary();
    return {
      service: "pigateway",
      mode: config.mode,
      atem: { configured: Boolean(config.atemHost), connected: atem.getState().connected },
      youtube: { state: youtube.get().state },
      encoder: { configured: encoder.getState().configured, connected: encoder.getState().connected },
      pivoice: pivoice.getState(),
      pisound: pisound.getState(),
      pivoiceActivity: pivoiceActivity.getState(),
      transcripts: { delivery: transcriptDelivery?.mode ?? null, ...transcripts.status(), source: auditorSse.status() },
      radioRelay: await radioRelay.safeLifecycle(),
      cameras: cameraService.list().map((cam) => ({ id: cam.id, connection: cam.connection })),
      ecosystem: eco,
      activePlugins: eco.activePlugins,
      inUseTabs: eco.inUseTabs
    };
  });

  app.get("/api/v1/ecosystem", async () => ecosystemTracker.getSummary());
  app.post("/api/v1/ecosystem/probe", async () => ecosystemTracker.probeAll());

  app.get("/api/v1/radio-relay", async () => radioRelay.safeLifecycle());
  app.get("/api/v1/radio-relay/stream", async (_request, reply) => { try { return await radioRelay.lifecycle(); } catch { return reply.code(502).send({ error: { code: "radio_relay_unavailable", message: "Unable to query radio relay lifecycle" } }); } });
  app.post("/api/v1/radio-relay/start", async (_request, reply) => { try { return await radioRelay.start(); } catch { return reply.code(502).send({ error: { code: "radio_relay_unavailable", message: "Unable to start radio relay stream" } }); } });
  app.post("/api/v1/radio-relay/stop", async (_request, reply) => { try { return await radioRelay.stop(); } catch { return reply.code(502).send({ error: { code: "radio_relay_unavailable", message: "Unable to stop radio relay stream" } }); } });

  app.get("/api/v1/activity/idle-close", async () => pivoiceActivity.getState());
  app.put("/api/v1/activity/idle-close", async (request, reply) => {
    const body = request.body as { idleCloseSeconds?: unknown } | undefined;
    if (!body || Object.keys(body).length !== 1 || !Number.isInteger(body.idleCloseSeconds) || (body.idleCloseSeconds as number) < 0 || (body.idleCloseSeconds as number) > 3600) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "idleCloseSeconds must be an integer from 0 to 3600" } });
    }
    return pivoiceActivity.setIdleCloseSeconds(body.idleCloseSeconds as number);
  });

  app.post("/api/v1/transcripts", async (request, reply) => {
    const body = request.body as { session_id?: unknown; events?: unknown } | undefined;
    const session = typeof body?.session_id === "string" ? body.session_id.trim().slice(0, 64) : "";
    if (!session || !Array.isArray(body?.events) || body.events.length === 0 || body.events.length > 100) {
      return reply.code(400).send({ error: { code: "invalid_request", message: "body must be { session_id, events: [1-100 transcripts] }" } });
    }
    const result = transcripts.ingest(session, body.events as unknown[]);
    // A batch with nothing usable is a client error; duplicates alone are fine (a retried push).
    if (result.accepted.length === 0 && result.duplicates === 0) {
      return reply.code(422).send({ error: { code: "invalid_transcripts", message: "no transcript in the batch was acceptable" }, rejected: result.rejected });
    }
    return reply.code(202).send({ accepted: result.accepted.length, duplicates: result.duplicates, rejected: result.rejected });
  });

  app.get("/api/v1/transcripts", async (request, reply) => {
    const query = request.query as { after?: string; limit?: string };
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? "200", 10) || 200));
    return reply.send({ epoch: transcripts.epoch, transcripts: transcripts.since(query.after, limit) });
  });

  app.get("/api/v1/events", async (request, reply) => {
    // ?types=transcript,pivoice limits the stream to those event types; "ready" is always sent.
    const typesParam = (request.query as { types?: string }).types;
    const wanted = typesParam ? new Set(typesParam.split(",").map((s) => s.trim()).filter(Boolean)) : null;
    const lastEventId = request.headers["last-event-id"];
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.write(
      `event: ready\ndata: ${JSON.stringify({ status: "connected", time: new Date().toISOString() })}\n\n`
    );
    const send = (event: GatewayEvent) => {
      if (wanted && !wanted.has(event.type)) return;
      const id = event.type === "transcript" ? `id: ${transcriptId(event.data)}\n` : "";
      try {
        reply.raw.write(`${id}event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      } catch {
        // socket closed
      }
    };
    // Replay and subscribe in the same tick, so nothing falls in between.
    if (typeof lastEventId === "string") {
      for (const missed of transcripts.since(lastEventId, 500)) send({ type: "transcript", data: missed });
    }
    const unsubscribe = eventBroker.subscribe(send);
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": keep-alive\n\n");
      } catch {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 15000);
    const clientParam = (request.query as { client?: string; types?: string }).client;
    const unregisterClient = clientParam ? ecosystemTracker.registerSseClient(clientParam) : undefined;
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      unregisterClient?.();
    });
  });

  return app;
}
