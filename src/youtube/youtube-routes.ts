/** HTTP routes for the YouTube live status and broadcasts that pitube reports. Writes go through the API auth hook. */

import type { FastifyInstance } from "fastify";
import { parseYoutubeStatus, type YoutubeStatusStore } from "./youtube-status.js";
import type { PiTubeClient } from "./client.js";

export function registerYoutubeRoutes(
  app: FastifyInstance,
  store: YoutubeStatusStore,
  client?: PiTubeClient
): void {
  app.get("/api/v1/youtube", async () => store.get());
  app.get("/api/v1/youtube/status", async (_request, reply) => {
    if (client) {
      try {
        return await client.getStatus();
      } catch {
        // Fall back to store if client request fails
      }
    }
    return store.get();
  });

  app.put<{ Body: unknown }>("/api/v1/youtube/status", async (request, reply) => {
    const parsed = parseYoutubeStatus(request.body);
    if (!parsed.ok) {
      return reply.code(422).send({ error: { code: "INVALID_INPUT", message: parsed.message } });
    }
    return store.set(parsed.value);
  });

  if (!client) return;

  // 1. Broadcasts listing & aliases
  const listHandler = async (_request: any, reply: any) => {
    try {
      return await client.listBroadcasts();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  };
  app.get("/api/v1/broadcasts", listHandler);
  app.get("/api/v1/youtube/broadcasts", listHandler);

  // 2. Current active broadcast & aliases
  const currentHandler = async (_request: any, reply: any) => {
    try {
      return await client.getCurrentBroadcast();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  };
  app.get("/api/v1/broadcasts/current", currentHandler);
  app.get("/api/v1/youtube/broadcasts/current", currentHandler);

  // 3. Select broadcast
  const selectHandler = async (request: any, reply: any) => {
    try {
      const broadcastId = request.body?.broadcastId?.trim();
      if (!broadcastId) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "broadcastId is required" } });
      }
      return await client.selectBroadcast(broadcastId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  };
  app.post<{ Body: { broadcastId?: string } }>("/api/v1/broadcasts/select", selectHandler);
  app.post<{ Body: { broadcastId?: string } }>("/api/v1/youtube/broadcasts/select", selectHandler);


  // 4. Create ad-hoc broadcast & alias
  const createHandler = async (request: any, reply: any) => {
    try {
      return await client.createBroadcast(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  };
  app.post("/api/v1/broadcasts/create", createHandler);
  app.post("/api/v1/youtube/broadcasts/create", createHandler);

  // 5. Start broadcast & alias
  const startHandler = async (request: any, reply: any) => {
    try {
      const to = request.body?.to;
      return await client.startBroadcast(to);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  };
  app.post<{ Body: { to?: string } | undefined }>("/api/v1/broadcasts/start", startHandler);
  app.post<{ Body: { to?: string } | undefined }>("/api/v1/youtube/broadcasts/start", startHandler);

  // 6. Stop request (confirmToken) & alias
  const stopRequestHandler = async (_request: any, reply: any) => {
    try {
      return await client.stopRequest();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  };
  app.post("/api/v1/broadcasts/stop/request", stopRequestHandler);
  app.post("/api/v1/youtube/broadcasts/stop/request", stopRequestHandler);

  // 7. Stop broadcast & alias
  const stopHandler = async (request: any, reply: any) => {
    try {
      const confirmToken = request.body?.confirmToken;
      return await client.stopBroadcast(confirmToken);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  };
  app.post<{ Body: { confirmToken?: string } | undefined }>("/api/v1/broadcasts/stop", stopHandler);
  app.post<{ Body: { confirmToken?: string } | undefined }>("/api/v1/youtube/broadcasts/stop", stopHandler);

  // 8. Edit broadcast
  app.patch<{ Params: { id: string }; Body: unknown }>("/api/v1/broadcasts/:id", async (request, reply) => {
    try {
      return await client.updateBroadcast(request.params.id, request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  // 9. Privacy
  app.post<{ Body: { privacy?: string; broadcastId?: string } }>("/api/v1/broadcasts/privacy", async (request, reply) => {
    try {
      const privacy = request.body?.privacy;
      if (!privacy) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "privacy is required" } });
      }
      return await client.setPrivacy(privacy, request.body?.broadcastId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  // 10. URLs
  app.get<{ Querystring: { broadcastId?: string } }>("/api/v1/broadcasts/url", async (request, reply) => {
    try {
      return await client.getUrls(request.query?.broadcastId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  // 11. Thumbnail upload
  app.post<{ Querystring: { broadcastId?: string } }>("/api/v1/broadcasts/thumbnail", async (request, reply) => {
    try {
      const contentType = String(request.headers["content-type"] ?? "").split(";")[0]!.trim();
      const body = request.body;
      if (!(body instanceof Uint8Array) && !(body instanceof Buffer)) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Raw binary image required" } });
      }
      return await client.setThumbnail(body, contentType, request.query?.broadcastId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  // 12. Streams (liveStreams)
  app.get("/api/v1/streams", async (_request, reply) => {
    try {
      return await client.listStreams();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  app.post<{ Body: { title?: string } }>("/api/v1/streams/create", async (request, reply) => {
    try {
      const title = request.body?.title || "pitube";
      return await client.createStream(title);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  // 13. Ingest apply
  app.post("/api/v1/ingest/apply", async (request, reply) => {
    try {
      return await client.applyIngestToEncoder(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  // 14. Auth check & health
  app.get("/api/v1/auth/health", async (_request, reply) => {
    try {
      return await client.getAuthHealth();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });

  app.post("/api/v1/auth/check", async (_request, reply) => {
    try {
      return await client.checkAuth();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pitube_unavailable", message: error.message } });
    }
  });
}
