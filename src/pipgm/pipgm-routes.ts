import type { FastifyInstance } from "fastify";
import type { PiProgramClient } from "./client.js";

export function registerPiPgmRoutes(app: FastifyInstance, options: { client: PiProgramClient }): void {
  const { client } = options;

  const handle = async (fn: () => Promise<unknown>, reply: any) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "PIPGM_ERROR", message: error.message }
      });
    }
  };

  // Pipelines
  app.get("/api/v1/pipgm/pipelines", async (_request, reply) => {
    return handle(() => client.getPipelines(), reply);
  });

  app.get<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId", async (request, reply) => {
    return handle(() => client.getPipeline(request.params.pipelineId), reply);
  });

  app.put<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId", async (request, reply) => {
    return handle(() => client.setPipeline(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/cue", async (request, reply) => {
    return handle(() => client.cuePipeline(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/step", async (request, reply) => {
    return handle(() => client.stepPipeline(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/play", async (request, reply) => {
    return handle(() => client.playPipeline(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/pause", async (request, reply) => {
    return handle(() => client.pausePipeline(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/audio", async (request, reply) => {
    return handle(() => client.audioPipeline(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/audio/stop", async (request, reply) => {
    return handle(() => client.audioStopPipeline(request.params.pipelineId), reply);
  });

  app.post("/api/v1/pipgm/audio/kill", async (_request, reply) => {
    return handle(() => client.killAudio(), reply);
  });

  app.put<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/playlist", async (request, reply) => {
    return handle(() => client.setPlaylist(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/playlist", async (request, reply) => {
    return handle(() => client.addToPlaylist(request.params.pipelineId, request.body), reply);
  });

  app.delete<{ Params: { pipelineId: string; itemId: string } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist/:itemId",
    async (request, reply) => {
      return handle(() => client.removeFromPlaylist(request.params.pipelineId, request.params.itemId), reply);
    }
  );

  // Library Items & Storage
  app.get("/api/v1/pipgm/items", async (_request, reply) => {
    return handle(() => client.listItems(), reply);
  });

  app.get<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    return handle(() => client.getItem(request.params.itemId), reply);
  });

  app.delete<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    return handle(() => client.deleteItem(request.params.itemId), reply);
  });

  app.post("/api/v1/pipgm/items/canva", async (request, reply) => {
    return handle(() => client.createCanvaItem(request.body), reply);
  });

  app.put<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId/use-at", async (request, reply) => {
    return handle(() => client.setUseAt(request.params.itemId, request.body), reply);
  });

  app.post<{ Params: { itemId: string }; Querystring: { orientation?: string } }>(
    "/api/v1/pipgm/items/:itemId/package",
    async (request, reply) => {
      return handle(() => client.packageItem(request.params.itemId, request.query?.orientation, request.body), reply);
    }
  );

  app.get<{ Params: { taskId: string } }>("/api/v1/pipgm/tasks/:taskId", async (request, reply) => {
    return handle(() => client.getTask(request.params.taskId), reply);
  });

  app.get<{ Params: { itemId: string }; Querystring: { orientation?: string } }>(
    "/api/v1/pipgm/items/:itemId/steps",
    async (request, reply) => {
      return handle(() => client.getItemSteps(request.params.itemId, request.query?.orientation), reply);
    }
  );

  app.post<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId/prepare", async (request, reply) => {
    return handle(() => client.prepareItem(request.params.itemId, request.body), reply);
  });

  app.get("/api/v1/pipgm/feeders", async (_request, reply) => {
    return handle(() => client.getFeeders(), reply);
  });

  app.get("/api/v1/pipgm/library/storage", async (_request, reply) => {
    return handle(() => client.getLibraryStorage(), reply);
  });
}
