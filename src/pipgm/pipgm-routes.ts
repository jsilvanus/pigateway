import type { FastifyInstance, FastifyReply } from "fastify";
import { PIPGM_UPLOAD_BODY_LIMIT, type PiProgramClient } from "./client.js";
import type { SoundOutputForwarder } from "./sound-output-forwarder.js";

type Orientation = { orientation?: string };

export function registerPiPgmRoutes(app: FastifyInstance, options: { client: PiProgramClient; soundForwarder?: SoundOutputForwarder }): void {
  const { client, soundForwarder } = options;

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

  // Runtime switches of piprogram (PiPGM publishing to MediaMTX, spoken announcements to the Pi HDMI audio).
  // All are off until someone turns them on; nothing here plays sound unless /audio/speak is called with dryRun false.
  app.get("/api/v1/pipgm/publish", async (_request, reply) => handle(() => client.request("GET", "/api/v1/pipgm/publish"), reply));
  app.put("/api/v1/pipgm/publish", async (request, reply) => handle(() => client.request("PUT", "/api/v1/pipgm/publish", request.body ?? {}), reply));
  app.get("/api/v1/pipgm/local-audio", async (_request, reply) => handle(() => client.request("GET", "/api/v1/pipgm/local-audio"), reply));
  app.put("/api/v1/pipgm/local-audio", async (request, reply) => handle(() => client.request("PUT", "/api/v1/pipgm/local-audio", request.body ?? {}), reply));
  app.get("/api/v1/pipgm/audio/sound-output", async (_request, reply) => handle(() => client.request("GET", "/api/v1/pipgm/audio/sound-output"), reply));
  app.put("/api/v1/pipgm/audio/sound-output", async (request, reply) => handle(() => client.request("PUT", "/api/v1/pipgm/audio/sound-output", request.body ?? {}), reply));
  app.post("/api/v1/pipgm/audio/speak", async (request, reply) => handle(() => client.request("POST", "/api/v1/pipgm/audio/speak", request.body ?? {}), reply));
  app.post("/api/v1/pipgm/audio/speak/stop", async (_request, reply) => handle(() => client.request("POST", "/api/v1/pipgm/audio/speak/stop"), reply));

  // Whether the gateway keeps piprogram told which Pi HDMI reaches the PA (answer comes from pimatrix).
  app.get("/api/v1/pipgm/audio/sound-output/forwarding", async (_request, reply) => {
    if (!soundForwarder) return reply.code(503).send({ error: { code: "FORWARDING_UNAVAILABLE", message: "sound output forwarding is not available" } });
    return soundForwarder.status();
  });
  app.put<{ Body: { enabled?: unknown } }>("/api/v1/pipgm/audio/sound-output/forwarding", async (request, reply) => {
    if (!soundForwarder) return reply.code(503).send({ error: { code: "FORWARDING_UNAVAILABLE", message: "sound output forwarding is not available" } });
    const enabled = request.body?.enabled;
    if (typeof enabled !== "boolean") return reply.code(422).send({ error: { code: "INVALID_ENABLED", message: "enabled must be a boolean" } });
    return soundForwarder.setEnabled(enabled);
  });

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

  // Live playlist of a feed: steps (read), order, load and save
  app.get<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/playlist/steps", async (request, reply) => {
    return handle(() => client.getPlaylistSteps(request.params.pipelineId), reply);
  });

  app.put<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/playlist/order", async (request, reply) => {
    return handle(() => client.setPlaylistOrder(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/playlist/load", async (request, reply) => {
    return handle(() => client.loadPlaylist(request.params.pipelineId, request.body), reply);
  });

  app.post<{ Params: { pipelineId: string } }>("/api/v1/pipgm/pipelines/:pipelineId/playlist/save", async (request, reply) => {
    return handle(() => client.savePlaylist(request.params.pipelineId, request.body), reply);
  });

  // Saved playlists
  app.get("/api/v1/pipgm/playlists", async (_request, reply) => {
    return handle(() => client.listSavedPlaylists(), reply);
  });

  app.post("/api/v1/pipgm/playlists", async (request, reply) => {
    return handle(() => client.createSavedPlaylist(request.body), reply);
  });

  app.post("/api/v1/pipgm/playlists/generate", async (request, reply) => {
    return handle(() => client.generatePlaylist(request.body), reply);
  });

  app.get<{ Params: { playlistId: string } }>("/api/v1/pipgm/playlists/:playlistId", async (request, reply) => {
    return handle(() => client.getSavedPlaylist(request.params.playlistId), reply);
  });

  app.put<{ Params: { playlistId: string } }>("/api/v1/pipgm/playlists/:playlistId", async (request, reply) => {
    return handle(() => client.replaceSavedPlaylist(request.params.playlistId, request.body), reply);
  });

  app.delete<{ Params: { playlistId: string } }>("/api/v1/pipgm/playlists/:playlistId", async (request, reply) => {
    return handle(() => client.deleteSavedPlaylist(request.params.playlistId), reply);
  });

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
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/v1/pipgm/items", async (request, reply) => {
    return handle(() => client.listItems(request.query), reply);
  });

  app.patch<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId", async (request, reply) => {
    return handle(() => client.updateItem(request.params.itemId, request.body), reply);
  });

  // Active folder: the items for a day (by use date) plus hand-picked ones
  app.get<{ Querystring: Record<string, string | undefined> }>("/api/v1/pipgm/library/active", async (request, reply) => {
    return handle(() => client.getActiveFolder(request.query), reply);
  });

  app.post("/api/v1/pipgm/library/active/playlist", async (request, reply) => {
    return handle(() => client.createPlaylistFromActiveFolder(request.body), reply);
  });

  app.put<{ Params: { itemId: string } }>("/api/v1/pipgm/library/active/:itemId", async (request, reply) => {
    return handle(() => client.addToActiveFolder(request.params.itemId), reply);
  });

  app.delete<{ Params: { itemId: string } }>("/api/v1/pipgm/library/active/:itemId", async (request, reply) => {
    return handle(() => client.removeFromActiveFolder(request.params.itemId), reply);
  });

  app.delete("/api/v1/pipgm/library/active", async (_request, reply) => {
    return handle(() => client.clearActiveFolder(), reply);
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

  // Sound and video previews in the browser need Range answers (Safari refuses a media file without them).
  // piprogram answers ranges for files it caches on disk; a file kept in storage comes whole and is cut here.
  app.get<{ Params: { assetId: string } }>("/api/v1/pipgm/assets/:assetId", async (request, reply) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
    try {
      const got = await client.getAsset(request.params.assetId, range && (range[1] || range[2]) ? String(request.headers.range) : undefined);
      reply.type(got.contentType).header("accept-ranges", "bytes").header("cache-control", "private, max-age=300");
      if (got.status === 206 && got.contentRange) return reply.code(206).header("content-range", got.contentRange).send(got.body);
      const size = got.body.length;
      if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start >= size || start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
        return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).send(got.body.subarray(start, end + 1));
      }
      return reply.send(got.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "PIPGM_ERROR", message: error.message } });
    }
  });

  app.get("/api/v1/pipgm/hymnals", async (_request, reply) => {
    return handle(() => client.getHymnals(), reply);
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

  app.post<{ Params: { itemId: string } }>("/api/v1/pipgm/items/:itemId/used-on", async (request, reply) => {
    return handle(() => client.addItemUsedOn(request.params.itemId, request.body), reply);
  });

  app.delete<{ Params: { itemId: string; date: string } }>("/api/v1/pipgm/items/:itemId/used-on/:date", async (request, reply) => {
    return handle(() => client.removeItemUsedOn(request.params.itemId, request.params.date), reply);
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
