import type { FastifyInstance } from "fastify";
import type { PiTimerClient } from "./client.js";

export function registerTimerRoutes(app: FastifyInstance, options: { client: PiTimerClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "TIMER_ERROR", message: error.message }
      });
    }
  };

  app.get("/api/v1/timers/status", async (_request, reply) => {
    return handle(() => client.getStatus(), reply);
  });

  app.post("/api/v1/timers/mute", async (request, reply) => {
    return handle(() => client.setMute(request.body), reply);
  });

  app.post("/api/v1/timers/unmute", async (_request, reply) => {
    return handle(() => client.unmute(), reply);
  });

  app.post("/api/v1/timers/parse", async (request, reply) => {
    return handle(() => client.parseScript(request.body), reply);
  });

  app.get("/api/v1/timers", async (_request, reply) => {
    return handle(() => client.listTimers(), reply);
  });

  app.post("/api/v1/timers", async (request, reply) => {
    return handle(() => client.createTimer(request.body), reply);
  });

  app.get<{ Params: { id: string } }>("/api/v1/timers/:id", async (request, reply) => {
    return handle(() => client.getTimer(request.params.id), reply);
  });

  app.put<{ Params: { id: string } }>("/api/v1/timers/:id", async (request, reply) => {
    return handle(() => client.updateTimer(request.params.id, request.body), reply);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/timers/:id", async (request, reply) => {
    return handle(() => client.deleteTimer(request.params.id), reply);
  });

  app.post<{ Params: { id: string } }>("/api/v1/timers/:id/mute", async (request, reply) => {
    return handle(() => client.muteTimer(request.params.id, request.body), reply);
  });

  app.post<{ Params: { id: string } }>("/api/v1/timers/:id/unmute", async (request, reply) => {
    return handle(() => client.unmuteTimer(request.params.id), reply);
  });

  app.post<{ Params: { id: string }; Body: { phase?: string } | undefined }>("/api/v1/timers/:id/run", async (request, reply) => {
    return handle(() => client.runPhase(request.params.id, request.body?.phase), reply);
  });

  app.post<{ Params: { runId: string } }>("/api/v1/timers/runs/:runId/cancel", async (request, reply) => {
    return handle(() => client.cancelRun(request.params.runId), reply);
  });

  app.get<{ Querystring: { limit?: string } }>("/api/v1/timers/runs", async (request, reply) => {
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return handle(() => client.listRuns(limit), reply);
  });
}
