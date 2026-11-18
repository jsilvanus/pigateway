import type { FastifyInstance, FastifyReply } from "fastify";
import { PIPGM_UPLOAD_BODY_LIMIT, type PiProgramClient } from "./client.js";

type Orientation = { orientation?: string };

export function registerPiPgmRoutes(app: FastifyInstance, options: { client: PiProgramClient }): void {
  const { client } = options;

  // Canva export packages arrive as a zip; the gateway keeps the bytes as they are and piprogram unpacks them.
  app.addContentTypeParser("application/zip", { parseAs: "buffer", bodyLimit: PIPGM_UPLOAD_BODY_LIMIT }, (_req, body, done) => {
    done(null, body);
  });

  const handle = async (fn: () => Promise<unknown>, reply: FastifyReply) => {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "PIPGM_ERROR", message: error.message }
      });
    }
  };

  const handleBinary = async (fn: () => Promise<{ body: Buffer; contentType: string }>, reply: FastifyReply) => {
    try {
      const { body, contentType } = await fn();
      return reply.type(contentType).send(body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({
        error: { code: error.code ?? "PIPGM_ERROR", message: error.message }
      });
    }
  };

  // Pipelines
  app.get<{ Querystring: { includeHidden?: string } }>("/api/v1/pipgm/pipelines", async (request, reply) => {
    return handle(() => client.getPipelines({ includeHidden: request.query?.includeHidden }), reply);
  });

  app.get<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId", async (request, reply) => {
    return handle(() => client.getPipeline(request.params.pipelineId), reply);
  });

  app.get<{ Params: { pipelineId: string }; Querystring: { width?: string; height?: string; alpha?: string } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/frame.png",
    async (request, reply) => {
      return handleBinary(() => client.getPipelineFrame(request.params.pipelineId, request.query), reply);
    }
  );

  app.put<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/config", async (request, reply) => {
    return handle(() => client.updatePipelineConfig(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/control", async (request, reply) => {
    return handle(() => client.controlPipeline(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/ftb", async (request, reply) => {
    return handle(() => client.setFadeToBlack(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/audio", async (request, reply) => {
    return handle(() => client.setPipelineAudio(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/audio/play", async (request, reply) => {
    return handle(() => client.playPipelineAudio(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/audio/stop", async (request, reply) => {
    return handle(() => client.stopPipelineAudio(request.params.pipelineId), reply);
  });

  app.post("/api/v1/pipgm/audio/kill", async (_request, reply) => {
    return handle(() => client.killAudio(), reply);
  });

  app.put<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/basic-image", async (request, reply) => {
    return handle(() => client.setPipelineBasicImage(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/playlist", async (request, reply) => {
    return handle(() => client.addPlaylistItem(request.params.pipelineId, request.body), reply);
  });

  app.delete<{ Params: { pipelineId: string; itemId: string } }>(
    "/api/v1/pipgm/pipelines/:pipelineId/playlist/:itemId",
    async (request, reply) => {
      return handle(() => client.removePlaylistItem(request.params.pipelineId, request.params.itemId), reply);
    }
  );

  // Legacy paths, kept for existing clients; they map to the control action of piprogram 1.0.
  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/cue", async (request, reply) => {
    return handle(() => client.cuePipeline(request.params.pipelineId, request.body as { itemId?: string; stepIndex?: number }), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/step", async (request, reply) => {
    return handle(() => client.stepPipeline(request.params.pipelineId), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/play", async (request, reply) => {
    return handle(() => client.playPipeline(request.params.pipelineId), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/pause", async (request, reply) => {
    return handle(() => client.pausePipeline(request.params.pipelineId), reply);
  });

  app.get("/api/v1/pipgm/feeders", async (_request, reply) => {
    return handle(() => client.getFeeders(), reply);
  });

  app.post("/api/v1/pipgm/tts/prepare", async (request, reply) => {
    return handle(() => client.prepareSpeech(request.body), reply);
  });

  // Library items and storage
  app.get("/api/v1/pipgm/items", async (_request, reply) => {
    return handle(() => client.listItems(), reply);
  });

  app.get<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    return handle(() => client.getItem(request.params.itemId), reply);
  });

  app.delete<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    return handle(() => client.deleteItem(request.params.itemId), reply);
  });

  app.get("/api/v1/pipgm/library/storage", async (_request, reply) => {
    return handle(() => client.getLibraryStorage(), reply);
  });

  app.get<{ Params: { assetId: string } }>("/api/v1/pipgm/assets/:assetId", async (request, reply) => {
    return handleBinary(() => client.getAsset(request.params.assetId), reply);
  });

  app.post("/api/v1/pipgm/items/hymn", async (request, reply) => {
    return handle(() => client.createHymnItem(request.body), reply);
  });

  app.post("/api/v1/pipgm/items/youtube", async (request, reply) => {
    return handle(() => client.createYouTubeItem(request.body), reply);
  });

  app.post("/api/v1/pipgm/items/media", { bodyLimit: PIPGM_UPLOAD_BODY_LIMIT }, async (request, reply) => {
    return handle(() => client.createMediaItem(request.body), reply);
  });

  app.post("/api/v1/pipgm/items/pptx", { bodyLimit: PIPGM_UPLOAD_BODY_LIMIT }, async (request, reply) => {
    return handle(() => client.createPptxItem(request.body), reply);
  });

  app.post("/api/v1/pipgm/items/canva", async (request, reply) => {
    return handle(() => client.createCanvaItem(request.body), reply);
  });

  app.put<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId/use-at", async (request, reply) => {
    return handle(() => client.setItemUseAt(request.params.itemId, request.body), reply);
  });

  app.get<{ Params: { itemId: string }; Querystring: Orientation }>("/api/v1/pipgm/items/:itemId/steps", async (request, reply) => {
    return handle(() => client.listItemSteps(request.params.itemId, request.query?.orientation), reply);
  });

  app.post<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId/prepare", async (request, reply) => {
    return handle(() => client.prepareItemSteps(request.params.itemId, request.body), reply);
  });

  app.get<{ Params: { itemId: string; step: string }; Querystring: Orientation }>(
    "/api/v1/pipgm/items/:itemId/steps/:step/image.png",
    async (request, reply) => {
      return handleBinary(() => client.getStepImage(request.params.itemId, Number(request.params.step), request.query?.orientation), reply);
    }
  );

  app.get<{ Params: { itemId: string; step: string }; Querystring: Orientation }>(
    "/api/v1/pipgm/items/:itemId/steps/:step/thumbnail.jpg",
    async (request, reply) => {
      return handleBinary(() => client.getStepThumbnail(request.params.itemId, Number(request.params.step), request.query?.orientation), reply);
    }
  );

  app.post<{ Params: { itemId: string }; Querystring: Orientation }>(
    "/api/v1/pipgm/items/:itemId/canva/export-package",
    { bodyLimit: PIPGM_UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      const isZip = String(request.headers["content-type"] ?? "").startsWith("application/zip");
      const body = isZip ? (request.body as Buffer) : request.body;
      return handle(
        () =>
          client.uploadCanvaExportPackage(request.params.itemId, body as Buffer | object, {
            orientation: request.query?.orientation,
            contentType: isZip ? "application/zip" : undefined
          }),
        reply
      );
    }
  );

  app.get<{ Params: { taskId: string } }>("/api/v1/pipgm/tasks/:taskId", async (request, reply) => {
    return handle(() => client.getTask(request.params.taskId), reply);
  });
}
