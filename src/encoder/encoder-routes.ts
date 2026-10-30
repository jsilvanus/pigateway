/** HTTP routes for the hardware streaming encoder (Matrox Monarch HDX). Supports multi-encoder numbering and standalone piencoder delegation. */

import type { FastifyInstance, FastifyReply } from "fastify";
import { EncoderError, type EncoderService, type EncoderTarget } from "./encoder-service.js";

const STATUS: Record<EncoderError["code"], number> = {
  ENCODER_NOT_CONFIGURED: 503,
  ENCODER_UNREACHABLE: 502,
  ENCODER_BUSY: 503,
  ENCODER_REFUSED: 409
};

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof EncoderError) {
    return reply.code(STATUS[error.code] ?? 500).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(422).send({ error: { code: "INVALID_INPUT", message } });
}

function parseTarget(value: unknown): EncoderTarget | null {
  if (value === undefined || value === "both") return "both";
  const n = Number(value);
  return n === 1 || n === 2 ? n : null;
}

export interface EncoderRoutesOptions {
  piencoderUrl?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}

export function registerEncoderRoutes(
  app: FastifyInstance,
  encoder: EncoderService,
  options: EncoderRoutesOptions = {}
): void {
  const piencoderUrl = options.piencoderUrl?.replace(/\/+$/, "");
  const fetchFn = options.fetchFn ?? fetch;

  // 1. List all encoders: GET /api/v1/encoders and GET /api/v1/encoder
  const listHandler = async (_request: any, reply: FastifyReply) => {
    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder`);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch {
        // fallback to local encoder
      }
    }
    const state = encoder.getState();
    const item1 = { ...state, id: 1 };
    return {
      ...item1,
      items: [item1]
    };
  };

  app.get("/api/v1/encoders", listHandler);
  app.get("/api/v1/encoder", listHandler);

  // 2. Backward-compatible un-numbered actions defaulting to encoder #1
  for (const action of ["start", "stop"] as const) {
    app.post<{ Body: { encoder?: unknown; channel?: unknown } | undefined }>(
      `/api/v1/encoder/${action}`,
      async (request, reply) => {
        const target = parseTarget(request.body?.channel ?? request.body?.encoder);
        if (target === null) return invalid(reply, 'encoder must be 1, 2 or "both"');

        if (piencoderUrl) {
          try {
            const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/1/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ channel: target })
            });
            const data = await res.json();
            return reply.code(res.status).send(data);
          } catch {
            // fallback
          }
        }

        try {
          return await (action === "start" ? encoder.startEncoder(target) : encoder.stopEncoder(target));
        } catch (error) {
          return fail(reply, error);
        }
      }
    );
  }

  app.get("/api/v1/encoder/input", async (_request, reply) => {
    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/1/input`);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch {
        // fallback
      }
    }
    try {
      return await encoder.getInputStatus();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/v1/encoder/settings", async (_request, reply) => {
    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/1/settings`);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch {
        // fallback
      }
    }
    try {
      return await encoder.getSettings();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Body: Record<string, unknown> | undefined }>("/api/v1/encoder/settings", async (request, reply) => {
    return handleSettingsPut(1, request, reply);
  });

  // 3. Numbered encoder routes: /api/v1/encoder/:number
  app.get<{ Params: { number: string } }>("/api/v1/encoder/:number", async (request, reply) => {
    const id = Number(request.params.number);
    if (!Number.isInteger(id) || id < 1) {
      return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND", message: `Invalid encoder: ${request.params.number}` } });
    }

    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/${id}`);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch {
        // fallback
      }
    }

    if (id === 1) {
      const state = encoder.getState();
      return { ...state, id: 1 };
    }

    return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND", message: `Encoder ${id} not found` } });
  });

  for (const action of ["start", "stop"] as const) {
    app.post<{ Params: { number: string }; Body: { encoder?: unknown; channel?: unknown } | undefined }>(
      `/api/v1/encoder/:number/${action}`,
      async (request, reply) => {
        const id = Number(request.params.number);
        if (!Number.isInteger(id) || id < 1) {
          return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND", message: `Invalid encoder: ${request.params.number}` } });
        }
        const target = parseTarget(request.body?.channel ?? request.body?.encoder);
        if (target === null) return invalid(reply, 'channel must be 1, 2 or "both"');

        if (piencoderUrl) {
          try {
            const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/${id}/${action}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ channel: target })
            });
            const data = await res.json();
            return reply.code(res.status).send(data);
          } catch {
            // fallback
          }
        }

        if (id === 1) {
          try {
            return await (action === "start" ? encoder.startEncoder(target) : encoder.stopEncoder(target));
          } catch (error) {
            return fail(reply, error);
          }
        }

        return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND", message: `Encoder ${id} not found` } });
      }
    );
  }

  app.get<{ Params: { number: string } }>("/api/v1/encoder/:number/input", async (request, reply) => {
    const id = Number(request.params.number);
    if (!Number.isInteger(id) || id < 1) return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });

    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/${id}/input`);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch {
        // fallback
      }
    }

    if (id === 1) {
      try {
        return await encoder.getInputStatus();
      } catch (error) {
        return fail(reply, error);
      }
    }

    return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });
  });

  app.get<{ Params: { number: string } }>("/api/v1/encoder/:number/settings", async (request, reply) => {
    const id = Number(request.params.number);
    if (!Number.isInteger(id) || id < 1) return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });

    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/${id}/settings`);
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch {
        // fallback
      }
    }

    if (id === 1) {
      try {
        return await encoder.getSettings();
      } catch (error) {
        return fail(reply, error);
      }
    }

    return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });
  });

  app.put<{ Params: { number: string }; Body: Record<string, unknown> | undefined }>(
    "/api/v1/encoder/:number/settings",
    async (request, reply) => {
      const id = Number(request.params.number);
      if (!Number.isInteger(id) || id < 1) return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });
      return handleSettingsPut(id, request, reply);
    }
  );

  async function handleSettingsPut(id: number, request: any, reply: FastifyReply) {
    const body = request.body ?? {};
    const { videoInput, audioInput, bitrateKbps, recordFileName } = body;
    if (videoInput !== undefined && videoInput !== "SDI" && videoInput !== "HDMI") return invalid(reply, "videoInput must be SDI or HDMI");
    if (audioInput !== undefined && audioInput !== "ANALOG" && audioInput !== "DIGITAL") return invalid(reply, "audioInput must be ANALOG or DIGITAL");
    if (bitrateKbps !== undefined && (!Number.isInteger(bitrateKbps) || (bitrateKbps as number) < 1)) return invalid(reply, "bitrateKbps must be a positive integer");
    if (recordFileName !== undefined && (typeof recordFileName !== "string" || !recordFileName.trim() || /[;\\/]/.test(recordFileName))) {
      return invalid(reply, "recordFileName must be a plain file name");
    }
    if (videoInput === undefined && audioInput === undefined && bitrateKbps === undefined && recordFileName === undefined) {
      return invalid(reply, "Give at least one of videoInput, audioInput, bitrateKbps, recordFileName");
    }

    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/${id}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        return reply.code(res.status).send(data);
      } catch {
        // fallback
      }
    }

    if (id === 1) {
      try {
        return await encoder.setSettings({
          ...(videoInput !== undefined && { videoInput: videoInput as "SDI" | "HDMI" }),
          ...(audioInput !== undefined && { audioInput: audioInput as "ANALOG" | "DIGITAL" }),
          ...(bitrateKbps !== undefined && { bitrateKbps: bitrateKbps as number }),
          ...(recordFileName !== undefined && { recordFileName: (recordFileName as string).trim() })
        });
      } catch (error) {
        return fail(reply, error);
      }
    }

    return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });
  }

  // 4. RTMP Configuration
  // /api/v1/encoder/:number/rtmp/:channel
  app.put<{ Params: { number: string; channel: string }; Body: { url?: unknown; streamName?: unknown } | undefined }>(
    "/api/v1/encoder/:number/rtmp/:channel",
    async (request, reply) => {
      const id = Number(request.params.number);
      const ch = Number(request.params.channel);
      if (!Number.isInteger(id) || id < 1) return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });
      if (ch !== 1 && ch !== 2) return invalid(reply, "channel must be 1 or 2");
      return handleRtmpPut(id, ch, request, reply);
    }
  );

  // /api/v1/encoder/:encoder/rtmp (legacy route where param was channel 1 or 2 on unit 1)
  app.put<{ Params: { encoder: string }; Body: { url?: unknown; streamName?: unknown } | undefined }>(
    "/api/v1/encoder/:encoder/rtmp",
    async (request, reply) => {
      const n = Number(request.params.encoder);
      if (n !== 1 && n !== 2) return invalid(reply, "encoder must be 1 or 2");
      return handleRtmpPut(1, n as 1 | 2, request, reply);
    }
  );

  async function handleRtmpPut(unitId: number, ch: 1 | 2, request: any, reply: FastifyReply) {
    const { url, streamName } = request.body ?? {};
    if (typeof url !== "string" || !/^rtmps?:\/\/[^;\s]+$/.test(url)) return invalid(reply, "url must be an rtmp:// or rtmps:// URL");
    if (typeof streamName !== "string" || !streamName || /[;\s]/.test(streamName)) return invalid(reply, "streamName is required and cannot contain ; or spaces");

    if (piencoderUrl) {
      try {
        const res = await fetchFn(`${piencoderUrl}/api/v1/encoder/${unitId}/rtmp/${ch}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, streamName })
        });
        if (res.status === 204) return reply.code(204).send();
        const data = await res.json().catch(() => null);
        return reply.code(res.status).send(data);
      } catch {
        // fallback
      }
    }

    if (unitId === 1) {
      try {
        await encoder.setRtmp(ch, { url, streamName });
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    }

    return reply.code(404).send({ error: { code: "ENCODER_NOT_FOUND" } });
  }
}
