/** HTTP routes for the Matrox Monarch HDX encoder. Writes go through the API auth hook. */

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
    return reply.code(STATUS[error.code]).send({ error: { code: error.code, message: error.message } });
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

export function registerEncoderRoutes(app: FastifyInstance, encoder: EncoderService): void {
  app.get("/api/v1/encoder", async () => encoder.getState());

  for (const action of ["start", "stop"] as const) {
    app.post<{ Body: { encoder?: unknown } | undefined }>(`/api/v1/encoder/${action}`, async (request, reply) => {
      const target = parseTarget(request.body?.encoder);
      if (target === null) return invalid(reply, 'encoder must be 1, 2 or "both"');
      try {
        return await (action === "start" ? encoder.startEncoder(target) : encoder.stopEncoder(target));
      } catch (error) {
        return fail(reply, error);
      }
    });
  }

  app.get("/api/v1/encoder/input", async (_request, reply) => {
    try {
      return await encoder.getInputStatus();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get("/api/v1/encoder/settings", async (_request, reply) => {
    try {
      return await encoder.getSettings();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Body: Record<string, unknown> | undefined }>("/api/v1/encoder/settings", async (request, reply) => {
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
  });

  app.put<{ Params: { encoder: string }; Body: { url?: unknown; streamName?: unknown } | undefined }>(
    "/api/v1/encoder/:encoder/rtmp",
    async (request, reply) => {
      const n = Number(request.params.encoder);
      if (n !== 1 && n !== 2) return invalid(reply, "encoder must be 1 or 2");
      const { url, streamName } = request.body ?? {};
      if (typeof url !== "string" || !/^rtmps?:\/\/[^;\s]+$/.test(url)) return invalid(reply, "url must be an rtmp:// or rtmps:// URL");
      if (typeof streamName !== "string" || !streamName || /[;\s]/.test(streamName)) return invalid(reply, "streamName is required and cannot contain ; or spaces");
      try {
        await encoder.setRtmp(n, { url, streamName });
        return reply.code(204).send();
      } catch (error) {
        return fail(reply, error);
      }
    }
  );
}
