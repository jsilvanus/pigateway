import type { FastifyInstance } from "fastify";
import type { PiTallyClient } from "./client.js";

export function registerTallyRoutes(
  app: FastifyInstance,
  { client }: { client: PiTallyClient }
): void {
  // 1. List lights
  app.get("/api/v1/lights", async (_request, reply) => {
    try {
      return await client.listLights();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 2. Create / register light
  app.post("/api/v1/lights", async (request, reply) => {
    try {
      return await client.createLight(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 3. Status summary
  app.get("/api/v1/lights/status", async (_request, reply) => {
    try {
      return await client.getStatus();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 4. Single light
  app.get<{ Params: { id: string } }>("/api/v1/lights/:id", async (request, reply) => {
    try {
      return await client.getLight(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 5. Delete light
  app.delete<{ Params: { id: string } }>("/api/v1/lights/:id", async (request, reply) => {
    try {
      return await client.deleteLight(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 6. Set light state (solid mode / color)
  app.post<{ Params: { id: string } }>("/api/v1/lights/:id/state", async (request, reply) => {
    try {
      return await client.setLightState(request.params.id, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 7. Send cue animation
  app.post<{ Params: { id: string } }>("/api/v1/lights/:id/cue", async (request, reply) => {
    try {
      return await client.sendLightCue(request.params.id, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 8. Send talent call
  app.post<{ Params: { id: string } }>("/api/v1/lights/:id/call", async (request, reply) => {
    try {
      return await client.sendLightCall(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 9. Hold data toggle
  app.post<{ Params: { id: string } }>("/api/v1/lights/:id/hold", async (request, reply) => {
    try {
      return await client.setLightHold(request.params.id, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 10. Brightness
  app.post<{ Params: { id: string } }>("/api/v1/lights/:id/brightness", async (request, reply) => {
    try {
      return await client.setLightBrightness(request.params.id, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 11. Cycle test
  app.post<{ Params: { id: string } }>("/api/v1/lights/:id/cycle", async (request, reply) => {
    try {
      return await client.cycleLight(request.params.id);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });

  // 12. Segment configuration
  app.post<{ Params: { id: string } }>("/api/v1/lights/:id/segments", async (request, reply) => {
    try {
      return await client.setLightSegments(request.params.id, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitally_unavailable", message: error.message } });
    }
  });
}
