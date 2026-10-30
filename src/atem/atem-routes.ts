/**
 * HTTP routes for the Video Mixer (ATEM switcher). Reads are open to any client that may
 * call the API; writes go through the API's existing auth hook (non-GET under
 * /api/v1/). When no mixer is configured the routes answer 503 instead of
 * pretending a switch happened.
 * Both /api/v1/video-mixer (canonical general) and /api/v1/atem (backward-compatible)
 * are served.
 */

import type { FastifyInstance } from "fastify";
import type { AtemAdapter, AtemAdapterState } from "./atem-adapter.js";

export interface AtemRouteOptions {
  /** Largest input number the ATEM accepts; defaults to 40 (ATEM Extreme ISO class). */
  maxInput?: number;
}

const DEFAULT_MAX_INPUT = 40;
/** Downstream keyers on an ATEM Extreme ISO class switcher. */
const MAX_DSK = 4;

function notConnected(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): unknown {
  return reply.code(503).send({
    error: { code: "ATEM_NOT_CONNECTED", message: "ATEM switcher is not connected" },
  });
}

function parseInput(value: unknown, max: number): number | null {
  const input = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(input) || input < 1 || input > max) return null;
  return input;
}

export function registerAtemRoutes(
  app: FastifyInstance,
  atem: AtemAdapter,
  options: AtemRouteOptions = {},
): void {
  const maxInput = options.maxInput ?? DEFAULT_MAX_INPUT;

  const MAX_STILL_BYTES = 64 * 1024 * 1024;
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_STILL_BYTES }, (_req, body, done) => {
    done(null, body);
  });

  function parseDsk(value: unknown): number | null {
    const dsk = Number(value);
    return Number.isInteger(dsk) && dsk >= 1 && dsk <= MAX_DSK ? dsk : null;
  }

  // Register /api/v1/atem (documented in OpenAPI). Also support /api/v1/switch, /api/v1/piswitch, and /api/v1/video-mixer.
  const prefixes = ["/api/v1/switch", "/api/v1/piswitch", "/api/v1/video-mixer", "/api/v1/atem"] as const;

  for (const prefix of prefixes) {
    app.get(prefix, async (): Promise<AtemAdapterState> => atem.getState());

    app.put<{ Body: { input?: unknown } }>(`${prefix}/program`, async (request, reply) => {
      const input = parseInput(request.body?.input, maxInput);
      if (input === null) {
        return reply.code(422).send({
          error: { code: "INVALID_INPUT", message: `ATEM input must be an integer between 1 and ${maxInput}` },
        });
      }
      if (!atem.getState().connected) return notConnected(reply);
      await atem.setProgram(input);
      return reply.code(200).send(atem.getState());
    });

    app.put<{ Body: { input?: unknown } }>(`${prefix}/preview`, async (request, reply) => {
      const input = parseInput(request.body?.input, maxInput);
      if (input === null) {
        return reply.code(422).send({
          error: { code: "INVALID_INPUT", message: `ATEM input must be an integer between 1 and ${maxInput}` },
        });
      }
      if (!atem.getState().connected) return notConnected(reply);
      await atem.setPreview(input);
      return reply.code(200).send(atem.getState());
    });

    app.post(`${prefix}/cut`, async (_request, reply) => {
      if (!atem.getState().connected) return notConnected(reply);
      await atem.cut();
      return reply.code(200).send(atem.getState());
    });

    app.post(`${prefix}/auto`, async (_request, reply) => {
      if (!atem.getState().connected) return notConnected(reply);
      await atem.autoTransition();
      return reply.code(200).send(atem.getState());
    });

    app.post(`${prefix}/ftb`, async (_request, reply) => {
      if (!atem.getState().connected) return notConnected(reply);
      await atem.fadeToBlack();
      return reply.code(200).send(atem.getState());
    });

    app.put<{ Params: { dsk: string }; Body: { onAir?: unknown } }>(`${prefix}/dsk/:dsk/on-air`, async (request, reply) => {
      const dsk = parseDsk(request.params.dsk);
      if (dsk === null || typeof request.body?.onAir !== "boolean") {
        return reply.code(422).send({
          error: { code: "INVALID_REQUEST", message: `dsk must be 1-${MAX_DSK} and onAir must be a boolean` },
        });
      }
      if (!atem.getState().connected) return notConnected(reply);
      await atem.setDownstreamKeyOnAir(dsk - 1, request.body.onAir);
      return reply.code(200).send(atem.getState());
    });

    app.put<{ Params: { dsk: string }; Body: { tie?: unknown } }>(`${prefix}/dsk/:dsk/tie`, async (request, reply) => {
      const dsk = parseDsk(request.params.dsk);
      if (dsk === null || typeof request.body?.tie !== "boolean") {
        return reply.code(422).send({
          error: { code: "INVALID_REQUEST", message: `dsk must be 1-${MAX_DSK} and tie must be a boolean` },
        });
      }
      if (!atem.getState().connected) return notConnected(reply);
      await atem.setDownstreamKeyTie(dsk - 1, request.body.tie);
      return reply.code(200).send(atem.getState());
    });

    app.put<{ Params: { slot: string }; Querystring: { name?: string }; Body: Buffer }>(
      `${prefix}/media/stills/:slot`,
      { bodyLimit: MAX_STILL_BYTES },
      async (request, reply) => {
        const slot = Number(request.params.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > 64 || !Buffer.isBuffer(request.body) || request.body.length === 0) {
          return reply.code(422).send({
            error: { code: "INVALID_REQUEST", message: "slot must be 1-64 and the body raw RGBA bytes (application/octet-stream)" },
          });
        }
        if (!atem.getState().connected) return notConnected(reply);
        await atem.uploadStill(slot - 1, request.body, request.query.name?.slice(0, 64) || "pigateway");
        return reply.code(200).send({ slot, bytes: request.body.length });
      },
    );

    app.put<{ Params: { dsk: string }; Body: { mediaPlayer?: unknown; slot?: unknown; fillInput?: unknown; cutInput?: unknown } }>(
      `${prefix}/dsk/:dsk/setup`,
      async (request, reply) => {
        const dsk = parseDsk(request.params.dsk);
        const { mediaPlayer, slot, fillInput, cutInput } = request.body ?? {};
        const ok = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;
        if (dsk === null || !ok(mediaPlayer, 4) || !ok(slot, 64) || !ok(fillInput, 65535) || !ok(cutInput, 65535)) {
          return reply.code(422).send({
            error: { code: "INVALID_REQUEST", message: "dsk 1-4, mediaPlayer 1-4, slot 1-64, fillInput and cutInput positive integers" },
          });
        }
        if (!atem.getState().connected) return notConnected(reply);
        await atem.setupDownstreamKey({ dsk: dsk - 1, mediaPlayer: mediaPlayer - 1, stillIndex: slot - 1, fillInput, cutInput });
        return reply.code(200).send(atem.getState());
      },
    );
  }
}
