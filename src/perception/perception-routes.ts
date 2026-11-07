import type { FastifyInstance } from "fastify";
import type { PiPerceptionClient } from "./client.js";
import type { GatewayEventBroker, PerceptionEventPayload } from "../events.js";
import type { ScreenTrackingUdpReceiver } from "./tracking-receiver.js";

export function registerPerceptionRoutes(
  app: FastifyInstance,
  options: {
    client: PiPerceptionClient;
    eventBroker?: GatewayEventBroker | undefined;
    trackingReceiver?: ScreenTrackingUdpReceiver | undefined;
  }
): void {
  const { client, eventBroker, trackingReceiver } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "PERCEPTION_ERROR", message: error.message },
      });
    }
  };

  // Streams
  app.get("/api/v1/perception/streams", async (_request, reply) => {
    return handle(() => client.getStreams(), reply);
  });

  app.post("/api/v1/perception/streams", async (request, reply) => {
    return handle(() => client.addStream(request.body), reply);
  });

  app.post<{ Params: { cameraId: string } }>("/api/v1/perception/streams/:cameraId/start", async (request, reply) => {
    return handle(() => client.startStream(request.params.cameraId), reply);
  });

  app.post<{ Params: { cameraId: string } }>("/api/v1/perception/streams/:cameraId/stop", async (request, reply) => {
    return handle(() => client.stopStream(request.params.cameraId), reply);
  });

  app.post<{ Params: { cameraId: string } }>("/api/v1/perception/streams/:cameraId/path", async (request, reply) => {
    return handle(() => client.setStreamPath(request.params.cameraId, request.body), reply);
  });

  app.get("/api/v1/perception/tracks", async (_request, reply) => {
    return handle(() => client.getTracks(), reply);
  });

  app.get("/api/v1/perception/pusher", async (_request, reply) => {
    return handle(() => client.getPusherStats(), reply);
  });

  // Screen tracking telemetry (from UDP receiver)
  app.get("/api/v1/perception/screen-tracks", async () => {
    if (!trackingReceiver) {
      return { listening: false, feeds: {}, packetCount: 0 };
    }
    return trackingReceiver.getState();
  });

  // Feeds lifecycle (MediaMTX / RTSP / ff-fleet)
  app.get("/api/v1/perception/feeds", async (_request, reply) => {
    return handle(() => client.getFeeds(), reply);
  });

  app.post("/api/v1/perception/feeds/setup", async (request, reply) => {
    return handle(() => client.setupFeeds(request.body), reply);
  });

  app.post<{ Params: { cameraId: string } }>("/api/v1/perception/feeds/:cameraId/setup", async (request, reply) => {
    return handle(() => client.setupFeed(request.params.cameraId, request.body), reply);
  });

  app.post<{ Params: { cameraId: string } }>("/api/v1/perception/feeds/:cameraId/start", async (request, reply) => {
    return handle(() => client.startFeed(request.params.cameraId), reply);
  });

  app.post<{ Params: { cameraId: string } }>("/api/v1/perception/feeds/:cameraId/stop", async (request, reply) => {
    return handle(() => client.stopFeed(request.params.cameraId), reply);
  });

  app.post("/api/v1/perception/feeds/start", async (_request, reply) => {
    return handle(() => client.startAllFeeds(), reply);
  });

  app.post("/api/v1/perception/feeds/stop", async (_request, reply) => {
    return handle(() => client.stopAllFeeds(), reply);
  });

  app.get("/api/v1/perception/telemetry/udp", async (_request, reply) => {
    return handle(() => client.getUdpTelemetryStats(), reply);
  });

  app.post<{ Body: PerceptionEventPayload }>("/api/v1/perception/events", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: { code: "INVALID_PERCEPTION_EVENT", message: "Invalid perception event payload" } });
    }
    eventBroker?.emit({
      type: "perception",
      data: body,
    });
    return reply.code(200).send({ ok: true });
  });
}
