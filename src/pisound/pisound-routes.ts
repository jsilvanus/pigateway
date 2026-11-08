import type { FastifyInstance } from "fastify";
import type { PiSoundClient } from "./client.js";

export function registerSoundRoutes(
  app: FastifyInstance,
  { client }: { client: PiSoundClient }
): void {
  // 1. Multi-mix management: List all configured mixes and master levels
  app.get("/api/v1/mixes", async (_request, reply) => {
    try {
      return await client.getMixes();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 2. Single mix state
  app.get<{ Params: { mixId: string } }>("/api/v1/mixes/:mixId", async (request, reply) => {
    try {
      return await client.getMix(request.params.mixId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 3. Set mix master volume
  app.post<{ Params: { mixId: string }; Body: { volumePercent?: number } }>(
    "/api/v1/mixes/:mixId/master/volume",
    async (request, reply) => {
      try {
        const { mixId } = request.params;
        const volumePercent = request.body?.volumePercent;
        if (typeof volumePercent !== "number") {
          return reply.code(400).send({ error: { code: "invalid_request", message: "Missing numeric field 'volumePercent'" } });
        }
        return await client.setMixMasterVolume(mixId, volumePercent);
      } catch (err: unknown) {
        const error = err as { statusCode?: number; code?: string; message?: string };
        return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
      }
    }
  );

  // 4. Set mix master mute
  app.post<{ Params: { mixId: string }; Body: { muted?: boolean } }>(
    "/api/v1/mixes/:mixId/master/mute",
    async (request, reply) => {
      try {
        const { mixId } = request.params;
        const muted = request.body?.muted;
        if (typeof muted !== "boolean") {
          return reply.code(400).send({ error: { code: "invalid_request", message: "Missing boolean field 'muted'" } });
        }
        return await client.setMixMasterMute(mixId, muted);
      } catch (err: unknown) {
        const error = err as { statusCode?: number; code?: string; message?: string };
        return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
      }
    }
  );

  // 5. Set channel send routing in mix
  app.post<{
    Params: { mixId: string; channelId: string };
    Body: { enabled?: boolean; volumePercent?: number };
  }>("/api/v1/mixes/:mixId/channels/:channelId", async (request, reply) => {
    try {
      const { mixId, channelId } = request.params;
      return await client.setMixChannel(mixId, channelId, request.body || {});
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 6. Toggle channel routing in mix
  app.post<{ Params: { mixId: string; channelId: string } }>(
    "/api/v1/mixes/:mixId/channels/:channelId/toggle",
    async (request, reply) => {
      try {
        const { mixId, channelId } = request.params;
        return await client.toggleMixChannel(mixId, channelId);
      } catch (err: unknown) {
        const error = err as { statusCode?: number; code?: string; message?: string };
        return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
      }
    }
  );

  // 7. Reset mixer to church acoustic baseline
  app.post("/api/v1/reset", async (_request, reply) => {
    try {
      return await client.resetToDefaults();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 8. Solo mic
  app.post<{ Params: { channelId: string } }>("/api/v1/mics/:channelId/solo", async (request, reply) => {
    try {
      return await client.soloMic(request.params.channelId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 9. Mute mic
  app.post<{ Params: { channelId: string }; Body: { muted?: boolean } }>("/api/v1/mics/:channelId/mute", async (request, reply) => {
    try {
      const muted = request.body?.muted;
      if (typeof muted !== "boolean") {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Missing boolean field 'muted'" } });
      }
      return await client.setMicMute(request.params.channelId, muted);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 10. Set mic gain
  app.post<{ Params: { channelId: string }; Body: { gainPercent?: number } }>("/api/v1/mics/:channelId/gain", async (request, reply) => {
    try {
      const gainPercent = request.body?.gainPercent;
      if (typeof gainPercent !== "number") {
        return reply.code(400).send({ error: { code: "invalid_request", message: "Missing numeric field 'gainPercent'" } });
      }
      return await client.setMicGain(request.params.channelId, gainPercent);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 11. Presets recall
  app.post<{ Params: { presetId: string } }>("/api/v1/presets/:presetId/recall", async (request, reply) => {
    try {
      const presetId = parseInt(request.params.presetId, 10);
      if (isNaN(presetId)) {
        return reply.code(400).send({ error: { code: "invalid_request", message: "presetId must be an integer" } });
      }
      return await client.recallPreset(presetId);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 12. Profiles
  app.get("/api/v1/profiles", async (_request, reply) => {
    try {
      return await client.getProfiles();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });

  // 13. Sound service full status
  app.get("/api/v1/sound/status", async (_request, reply) => {
    try {
      return await client.getStatus();
    } catch (err: unknown) {
      const error = err as { statusCode?: number; code?: string; message?: string };
      return reply.code(error.statusCode ?? 502).send({ error: { code: error.code ?? "pisound_unavailable", message: error.message } });
    }
  });
}
