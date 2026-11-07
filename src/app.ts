import Fastify, { type FastifyInstance } from "fastify";
import { createAmxClient } from "./amx/amx-client.js";
import { AmxTcpListener, tcpVideoForward, type AmxControl } from "./amx/amx-listener.js";
import { AtlonaMatrix } from "./amx/atlona.js";
import { registerProjectorRoutes } from "./amx/projector-routes.js";
import { CanvaService } from "./canva/canva-service.js";
import { registerCanvaRoutes, type CanvaRoutesOptions } from "./canva/canva-routes.js";
import { buildCanvaTunnelApp } from "./canva/canva-tunnel.js";
import { createCanvaUserAuth } from "./canva/canva-user-auth.js";
import { REDACT_PATHS, serializers } from "./log/redact.js";
import { AtemAdapter, type AtemClient } from "./atem/atem-adapter.js";
import { SimulatedAtemClient } from "./simulation/simulated-atem.js";
import { SimulatedMonarch } from "./simulation/simulated-monarch.js";
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
import { PiVoiceClient } from "./pivoice/client.js";
import { registerVoiceRoutes } from "./pivoice/voice-routes.js";
import { PiSoundClient } from "./pisound/client.js";
import { registerSoundRoutes } from "./pisound/pisound-routes.js";
import { PiTallyClient } from "./tally/client.js";
import { registerTallyRoutes } from "./tally/tally-routes.js";
import { PiTubeClient } from "./youtube/client.js";
import { PiMatrixClient } from "./matrix/client.js";
import { registerMatrixProxyRoutes } from "./matrix/matrix-proxy-routes.js";
import { PiGraphicsClient } from "./graphics/client.js";
import { registerGraphicsRoutes } from "./graphics/graphics-routes.js";
import { PiProgramClient } from "./pipgm/client.js";
import { registerPiPgmRoutes } from "./pipgm/pipgm-routes.js";
import { PiDesignerClient } from "./designer/client.js";
import { registerDesignerRoutes } from "./designer/designer-routes.js";
import { RadioRelayClient } from "./radio-relay/radio-relay-client.js";
import { AuditorSseSource } from "./transcripts/auditor-sse-source.js";
import { TranscriptHub, transcriptId } from "./transcripts/transcript-hub.js";
import { EcosystemTracker } from "./ecosystem/ecosystem-tracker.js";
import { ActionRegistry } from "./actions/action-registry.js";
import { registerActionRoutes } from "./actions/action-routes.js";
import { RundownStore } from "./rundown/rundown-store.js";
import { registerRundownRoutes } from "./rundown/rundown-routes.js";
import { SpatialStatusStore } from "./spatial/spatial-status.js";
import { registerSpatialRoutes } from "./spatial/spatial-routes.js";
import { WorldStateAggregator } from "./world/world-state.js";
import { registerWorldStateRoutes } from "./world/world-routes.js";
import { PiPoeClient } from "./pipoe/client.js";
import { registerPoeRoutes } from "./pipoe/poe-routes.js";
import { PiStorageClient } from "./storage/client.js";
import { registerStorageRoutes } from "./storage/storage-routes.js";
import { PiAgentClient } from "./piagent/client.js";
import { registerAgentRoutes } from "./piagent/agent-routes.js";
import { PiNotifyClient } from "./notify/client.js";
import { registerNotifyRoutes } from "./notify/notify-routes.js";
import { PiPerceptionClient } from "./perception/client.js";
import { registerPerceptionRoutes } from "./perception/perception-routes.js";
import { ScreenTrackingUdpReceiver } from "./perception/tracking-receiver.js";
import { PiSpaceClient } from "./spatial/client.js";

export function buildApp(config: AppConfig): FastifyInstance {
  const app = Fastify({
    trustProxy: true,
    logger: {
      level: process.env.PIGATEWAY_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info",
      redact: REDACT_PATHS,
      serializers
    },
    // Replaced by the audit line below: no per-request "incoming request" noise.
    disableRequestLogging: true
  });

  // One audit line per request: method, route pattern, status, duration, source host. No query, headers or body.
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "(unmatched)";
    if (route === "/health") return;
    const status = reply.statusCode;
    const level = status >= 500 ? "error" : status >= 400 ? "warn" : request.method === "GET" ? "debug" : "info";
    request.log[level](
      { event: "http_request", component: "http", method: request.method, route, status, durationMs: Math.round(reply.elapsedTime), source: request.ip },
      "request"
    );
  });

  // Every route as "METHOD /path/{param}", for the test that keeps openapi/openapi.json in step.
  const routeTable = new Set<string>();
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) {
      if (
        method !== "HEAD" &&
        method !== "OPTIONS" &&
        !route.url.startsWith("/api/v1/video-mixer") &&
        !route.url.startsWith("/api/v1/switch") &&
        !route.url.startsWith("/api/v1/piswitch") &&
        !route.url.startsWith("/api/v1/youtube/broadcasts") &&
        !(route.url === "/api/v1/youtube/status" && method === "GET") &&
        route.url !== "/api/v1/encoders" &&
        !route.url.includes("/rtmp/") &&
        route.url !== "/api/v1/encoder/:number" &&
        route.url !== "/api/v1/encoder/:number/start" &&
        route.url !== "/api/v1/encoder/:number/stop" &&
        route.url !== "/api/v1/encoder/:number/input" &&
        route.url !== "/api/v1/encoder/:number/settings"
      ) routeTable.add(`${method} ${route.url.replace(/:(\w+)/g, "{$1}").replace(/\/\*$/, "/{key}")}`);
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
  const pivoiceClient = new PiVoiceClient({
    baseUrl: config.pivoiceApiUrl,
    token: config.pivoiceApiToken,
    logger: app.log
  });
  const pisoundClient = new PiSoundClient({
    baseUrl: config.pisoundApiUrl,
    token: config.pisoundApiToken,
    logger: app.log
  });
  const pitallyClient = new PiTallyClient({
    baseUrl: config.pitallyApiUrl,
    logger: app.log
  });
  const pitubeClient = new PiTubeClient({
    baseUrl: config.pitubeApiUrl,
    token: config.pitubeApiToken,
    logger: app.log
  });
  const pimatrixClient = new PiMatrixClient({
    baseUrl: config.pimatrixApiUrl,
    logger: app.log
  });
  const pigraphicsClient = new PiGraphicsClient({
    baseUrl: config.pigraphicsApiUrl,
    logger: app.log
  });
  const piprogramClient = new PiProgramClient({
    baseUrl: config.piprogramApiUrl,
    token: config.piprogramApiKey,
    logger: app.log
  });
  const pidesignerClient = new PiDesignerClient({
    baseUrl: config.pirundownDesignerApiUrl,
    logger: app.log
  });
  const pipoeClient = new PiPoeClient({
    baseUrl: config.pipoeApiUrl,
    token: config.pipoeApiKey,
    logger: app.log
  });
  const pistorageClient = new PiStorageClient({
    baseUrl: config.pistorageApiUrl,
    token: config.pistorageApiKey,
    logger: app.log
  });
  const piagentClient = new PiAgentClient({
    baseUrl: config.piagentApiUrl,
    token: config.piagentApiKey,
    logger: app.log
  });
  const pinotifyClient = new PiNotifyClient({
    baseUrl: config.pinotifyApiUrl,
    token: config.pinotifyApiKey,
    logger: app.log
  });
  const piperceptionClient = new PiPerceptionClient({
    baseUrl: config.piperceptionApiUrl,
    token: config.piperceptionApiKey,
    logger: app.log
  });
  const pispaceClient = new PiSpaceClient({
    baseUrl: config.pispaceApiUrl,
    token: config.pispaceApiKey,
    logger: app.log
  });
  const radioRelay = new RadioRelayClient({
    baseUrl: config.radioRelayApiUrl,
    token: config.radioRelayApiToken,
    streamName: config.radioRelayStreamName,
    mountPoint: config.radioRelayMountPoint,
    publicUrl: config.radioRelayPublicUrl,
    logger: app.log
  });
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

  const trackingReceiver = config.perceptionUdpEnabled
    ? new ScreenTrackingUdpReceiver({
        host: config.perceptionUdpHost ?? "0.0.0.0",
        port: config.perceptionUdpPort ?? 40002,
        logger: app.log,
        eventBroker
      })
    : undefined;

  // Simulation mode with no real device configured: in-memory ATEM and encoder behind the same seams as hardware.
  const simulateAtem = config.mode === "simulation" && !config.atemHost;
  const simulateEncoder = config.mode === "simulation" && !config.encoderHost;
  const atem = new AtemAdapter({ logger: app.log, ...(simulateAtem ? { createClient: () => new SimulatedAtemClient() as unknown as AtemClient } : {}) });
  atem.onStateChange((state) => eventBroker.emit({ type: "atem", data: state }));
  registerAtemRoutes(app, atem);

  const encoder = new EncoderService({
    ...(simulateEncoder ? { device: new SimulatedMonarch() } : {}),
    host: config.encoderHost,
    username: config.encoderUser,
    password: config.encoderPassword,
    https: config.encoderHttps,
    logger: app.log,
    onChange: (state) => eventBroker.emit({ type: "encoder", data: state })
  });
  registerEncoderRoutes(app, encoder, { piencoderUrl: config.piencoderApiUrl });

  const youtube = new YoutubeStatusStore({ onChange: (record) => eventBroker.emit({ type: "youtube", data: record }) });
  registerYoutubeRoutes(app, youtube, pitubeClient);

  const cameraService = new CameraService({
    mode: config.mode,
    eventBroker,
    logger: app.log,
    picamApiUrl: config.picamApiUrl,
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

  let freedBindError: string | null = null;
  let freedRetry: NodeJS.Timeout | null = null;
  let amxRetry: NodeJS.Timeout | null = null;
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
  if (config.mode === "simulation" && !config.amxMasterHost && !config.amxSimulated) {
    // Plausible starting routes for the simulated matrix (output 5 mirrors output 4).
    Object.assign(matrix.state.routes, { 1: 2, 2: 2, 3: 1, 4: 2, 5: 2 });
  }
  matrix.register(app, config.mode);
  registerProjectorRoutes(app, amxClient);
  const canvaService = new CanvaService({
    piprogramUrl: config.piprogramApiUrl ?? "http://127.0.0.1:3200",
    piprogramApiKey: config.piprogramApiKey,
    downloadHosts: config.canvaDownloadHosts,
    logger: app.log
  });
  const canvaRouteOptions: CanvaRoutesOptions = {
    routeMatrix: (input, output) => matrix.route(input, output, config.mode),
    matrixRoutes: () => ({ ...matrix.state.routes }),
    setPictureMute: (target, muted) => amxClient.epsonCommand(target, "MUTE", muted ? "ON" : "OFF")
  };
  registerCanvaRoutes(app, canvaService, canvaRouteOptions);
  if (config.canvaTunnelPort !== undefined) {
    // Same service and routes, on a separate local port that needs the API key or a Canva user token of an allowed team (see canva-tunnel.ts).
    const userAuth = config.canvaAppId ? createCanvaUserAuth({ appId: config.canvaAppId, allowedBrands: config.canvaAllowedBrands ?? [] }) : undefined;
    const tunnel = buildCanvaTunnelApp({ apiKey: config.apiKey, corsOrigins: config.canvaTunnelCorsOrigins, userAuth }, canvaService, canvaRouteOptions, app.log);
    app.decorate("canvaTunnel", tunnel);
    app.addHook("onClose", async () => {
      await tunnel.close();
    });
  }

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

  const rundownStore = new RundownStore({ eventBroker });
  const actionRegistry = new ActionRegistry({
    config,
    atem,
    cameraService,
    encoder,
    matrix,
    ecosystemTracker,
    eventBroker,
    rundownStore,
  });
  rundownStore.setActionRegistry(actionRegistry);
  registerActionRoutes(app, actionRegistry);
  registerRundownRoutes(app, rundownStore, { pirundownUrl: config.pirundownApiUrl ?? "http://127.0.0.1:3400" });
  const spatialStore = new SpatialStatusStore(eventBroker);
  registerSpatialRoutes(app, { store: spatialStore, client: pispaceClient });
  const worldStateAggregator = new WorldStateAggregator({
    eventBroker,
    getSpatial: () => spatialStore.get(),
    getPiVoice: () => pivoice.getState(),
    getPiSound: () => pisound.getState(),
    getRundown: () => rundownStore.getStatus(),
    getAtem: () => {
      const s = atem.getState();
      return { connected: s.connected, programInput: s.programInput, previewInput: s.previewInput };
    },
  });
  registerWorldStateRoutes(app, worldStateAggregator);
  (app as unknown as { worldStateAggregator: WorldStateAggregator }).worldStateAggregator = worldStateAggregator;
  (app as unknown as { rundownStore: RundownStore }).rundownStore = rundownStore;

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

  // A missing or broken device must never stop the gateway from starting: every step is isolated,
  // failures are logged, and the steps that can be retried (AMX listener, FreeD) retry.
  const safely = async (step: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (err: unknown) {
      app.log.error({ event: "startup_step_failed", component: "lifecycle", step, err }, "Startup step failed; the gateway keeps running");
    }
  };

  app.addHook("onReady", async () => {
    await safely("pisound", async () => {
      if (await ecosystemTracker.shouldStartPisoundReceiver()) {
        await pisound.start().catch((error: unknown) => {
          app.log.error({ err: error, port: config.pisoundUdpPort }, "Unable to start PiSound UDP telemetry receiver");
        });
        ecosystemTracker.markPisoundReceiverStarted();
      } else {
        app.log.info({ port: config.pisoundUdpPort }, "PiSound is not active; skipping UDP telemetry receiver startup");
      }
    });
    if (config.pivoiceEnabled !== false) {
      await safely("pivoice", () =>
        pivoice.start().catch((error: unknown) => {
          app.log.error({ err: error, port: config.pivoiceUdpPort }, "Unable to start PiVoice UDP telemetry receiver");
        })
      );
    }
    await safely("ecosystem", () => ecosystemTracker.start());
    if (amxListener) {
      const startAmx = async (): Promise<void> => {
        try {
          await amxListener.start();
        } catch (err: unknown) {
          app.log.error({ event: "amx_listener_failed", component: "amx-6600", err }, "AMX TCP listener failed to start; retrying in 15 s");
          amxRetry = setTimeout(() => void startAmx(), 15_000);
        }
      };
      await startAmx();
    }
    if (trackingReceiver) await safely("screen-tracking-udp", () => trackingReceiver.start());
    if (config.amxMasterHost) await safely("atlona-polling", () => matrix.startPolling());
    await safely("encoder", () => encoder.start());
    if (freedReceiver) {
      const startFreed = async (): Promise<void> => {
        try {
          await freedReceiver.start();
          freedBindError = null;
        } catch (err: unknown) {
          freedBindError = err instanceof Error ? err.message : String(err);
          app.log.warn({ err }, "FreeD UDP receiver failed to start; retrying in 15 s");
          freedRetry = setTimeout(() => void startFreed(), 15_000);
          freedRetry.unref();
        }
      };
      await startFreed();
    }
    if (simulateAtem) {
      void atem.connect("simulated").catch(() => undefined);
    } else if (config.atemHost) {
      // Not awaited: with the ATEM unreachable the library's connect() can stay pending for good,
      // which would hold up onReady (and so the HTTP listen) and leave nothing keeping the process alive.
      void atem.connect(config.atemHost, config.atemPort).catch((error: unknown) => {
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
      trackingReceiver ? trackingReceiver.stop() : Promise.resolve(),
      pivoiceActivity.close(),
      atem.disconnect(),
      cameraService.close(),
      (amxRetry ? clearTimeout(amxRetry) : undefined, freedRetry ? clearTimeout(freedRetry) : undefined, freedReceiver ? freedReceiver.stop() : Promise.resolve()),
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

  // A FreeD bind failure (port held by another process) is shown here instead of only in the log.
  app.get("/health", async () => {
    const problems: string[] = [];
    if (freedReceiver && !freedReceiver.getStats().listening) {
      problems.push(`FreeD UDP port ${config.freedUdpPort} is not bound${freedBindError ? `: ${freedBindError}` : ""}`);
    }
    return problems.length
      ? { status: "degraded", service: "pigateway", problems }
      : { status: "ok", service: "pigateway" };
  });

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
      freed: freedReceiver ? freedReceiver.getStats() : null,
      spatial: spatialStore.get(),
      worldState: worldStateAggregator.get(),
      ecosystem: eco,
      activePlugins: eco.activePlugins,
      inUseTabs: eco.inUseTabs
    };
  });

  app.get("/api/v1/ecosystem", async () => ecosystemTracker.getSummary());
  app.get("/api/v1/ui/modules", async () => ({
    modules: config.uiModules ?? null,
    restricted: config.uiModules !== undefined,
  }));
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

  registerVoiceRoutes(app, { client: pivoiceClient, transcripts });
  registerSoundRoutes(app, { client: pisoundClient });
  registerTallyRoutes(app, { client: pitallyClient });
  registerMatrixProxyRoutes(app, { client: pimatrixClient });
  registerGraphicsRoutes(app, { client: pigraphicsClient });
  registerPiPgmRoutes(app, { client: piprogramClient });
  registerDesignerRoutes(app, { client: pidesignerClient });
  registerPoeRoutes(app, { client: pipoeClient });
  registerStorageRoutes(app, { client: pistorageClient });
  registerAgentRoutes(app, { client: piagentClient });
  registerNotifyRoutes(app, { client: pinotifyClient });
  registerPerceptionRoutes(app, { client: piperceptionClient, eventBroker, trackingReceiver });

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
    const currentRundown = rundownStore.getStatus();
    if (currentRundown.loaded && (!wanted || wanted.has("rundown"))) {
      reply.raw.write(`event: rundown\ndata: ${JSON.stringify(currentRundown)}\n\n`);
    }
    const currentWorldState = worldStateAggregator.get();
    if (!wanted || wanted.has("world-state")) {
      reply.raw.write(`event: world-state\ndata: ${JSON.stringify(currentWorldState)}\n\n`);
    }
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

  app.post<{ Body: { type?: string; data?: unknown } }>("/api/v1/events", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || typeof body.type !== "string") {
      return reply.code(400).send({ error: { code: "invalid_request", message: "body must have { type, data }" } });
    }
    eventBroker.emit(body as GatewayEvent);
    return reply.code(200).send({ ok: true });
  });

  return app;
}

