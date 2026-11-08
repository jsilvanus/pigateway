import type { FastifyInstance } from "fastify";
import type { SpatialStatusStore } from "./spatial-status.js";
import type { PiSpaceClient } from "./client.js";
import type { SpatialScenePayload, SpatialZoneEventPayload } from "../events.js";

export function registerSpatialRoutes(
  app: FastifyInstance,
  optionsOrStore: SpatialStatusStore | { store: SpatialStatusStore; client?: PiSpaceClient | undefined }
): void {
  const store = "get" in optionsOrStore ? optionsOrStore : optionsOrStore.store;
  const client = "client" in optionsOrStore ? optionsOrStore.client : undefined;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "SPATIAL_ERROR", message: error.message }
      });
    }
  };

  app.get("/api/v1/spatial", async () => store.get());

  app.put<{ Body: SpatialScenePayload }>("/api/v1/spatial/scene", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || !Array.isArray(body.activeZones) || !Array.isArray(body.subjects)) {
      return reply.code(422).send({ error: { code: "INVALID_SPATIAL_SCENE", message: "Invalid spatial scene payload" } });
    }
    return store.updateScene(body);
  });

  app.post<{ Body: SpatialZoneEventPayload }>("/api/v1/spatial/events", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object" || !body.event || !body.zoneId || body.trackId == null) {
      return reply.code(422).send({ error: { code: "INVALID_ZONE_EVENT", message: "Invalid spatial zone event payload" } });
    }
    store.emitZoneEvent(body);
    return { ok: true };
  });

  // Proxy routes to PiSpace
  app.get("/api/v1/spatial/venue", async (_request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.getVenue(), reply);
  });

  app.get("/api/v1/spatial/zones", async (_request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.getZones(), reply);
  });

  app.get<{ Params: { zoneId: string } }>("/api/v1/spatial/zones/:zoneId", async (request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.getZone(request.params.zoneId), reply);
  });

  app.get("/api/v1/spatial/occluders", async (_request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.getOccluders(), reply);
  });

  app.get<{ Params: { id: string } }>("/api/v1/spatial/occluders/:id", async (request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.getOccluder(request.params.id), reply);
  });

  app.post("/api/v1/spatial/solve-ptz", async (request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.solvePtz(request.body), reply);
  });

  app.post("/api/v1/spatial/project", async (request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.project(request.body), reply);
  });

  app.post("/api/v1/spatial/triangulate", async (request, reply) => {
    if (!client?.configured()) return reply.code(503).send({ error: { code: "PISPACE_NOT_CONFIGURED", message: "PiSpace is not configured" } });
    return handle(() => client.triangulate(request.body), reply);
  });
}
