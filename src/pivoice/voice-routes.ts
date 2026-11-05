import type { FastifyInstance } from "fastify";
import type { PiVoiceClient } from "./client.js";
import type { TranscriptHub } from "../transcripts/transcript-hub.js";

export function registerVoiceRoutes(
  app: FastifyInstance,
  { client, transcripts }: { client: PiVoiceClient; transcripts: TranscriptHub }
): void {
  app.get("/api/v1/voice/status", async (_request, reply) => {
    try {
      return await client.getStatus();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.get("/api/v1/voice/config", async (_request, reply) => {
    try {
      return await client.getConfig();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.put("/api/v1/voice/config", async (request, reply) => {
    try {
      return await client.updateConfig(request.body);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.post("/api/v1/voice/capture", async (request, reply) => {
    try {
      const body = request.body as { action?: string; running?: boolean } | undefined;
      if (body?.action === "stop" || body?.running === false) {
        return await client.stopCapture();
      }
      return await client.startCapture();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.post("/api/v1/voice/capture/start", async (_request, reply) => {
    try {
      return await client.startCapture();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.post("/api/v1/voice/capture/stop", async (_request, reply) => {
    try {
      return await client.stopCapture();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.get("/api/v1/voice/transcripts", async (request, reply) => {
    const query = request.query as { after?: string; limit?: string };
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? "200", 10) || 200));
    return reply.send({ epoch: transcripts.epoch, transcripts: transcripts.since(query.after, limit) });
  });

  app.get("/api/v1/voice/radio", async (_request, reply) => {
    try {
      return await client.getRadio();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.put<{ Params: { target: string }; Body: { mode?: string } }>("/api/v1/voice/radio/:target/mode", async (request, reply) => {
    try {
      const { target } = request.params;
      const body = request.body;
      if (!body?.mode) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "mode is required" } });
      }
      return await client.setRadioTargetMode(target, body.mode);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });

  app.get("/api/v1/voice/captions", async (_request, reply) => {
    try {
      return await client.getCaptionsStatus();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pivoice_unavailable", message: error.message } });
    }
  });
}
