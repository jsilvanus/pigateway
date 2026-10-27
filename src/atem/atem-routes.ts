/**
 * HTTP routes for the ATEM switcher. Reads are open to any client that may
 * call the API; writes go through the API's existing auth hook (non-GET under
 * /api/v1/). When no ATEM is configured the routes answer 503 instead of
 * pretending a switch happened.
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

  app.get("/api/v1/atem", async (): Promise<AtemAdapterState> => atem.getState());

  app.put<{ Body: { input?: unknown } }>("/api/v1/atem/program", async (request, reply) => {
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

  app.put<{ Body: { input?: unknown } }>("/api/v1/atem/preview", async (request, reply) => {
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

  app.post("/api/v1/atem/cut", async (_request, reply) => {
    if (!atem.getState().connected) return notConnected(reply);
    await atem.cut();
    return reply.code(200).send(atem.getState());
  });

  app.post("/api/v1/atem/auto", async (_request, reply) => {
    if (!atem.getState().connected) return notConnected(reply);
    await atem.autoTransition();
    return reply.code(200).send(atem.getState());
  });

  app.post("/api/v1/atem/ftb", async (_request, reply) => {
    if (!atem.getState().connected) return notConnected(reply);
    await atem.fadeToBlack();
    return reply.code(200).send(atem.getState());
  });

  function parseDsk(value: unknown): number | null {
    const dsk = Number(value);
    return Number.isInteger(dsk) && dsk >= 1 && dsk <= MAX_DSK ? dsk : null;
  }

  app.put<{ Params: { dsk: string }; Body: { onAir?: unknown } }>("/api/v1/atem/dsk/:dsk/on-air", async (request, reply) => {
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

  app.put<{ Params: { dsk: string }; Body: { tie?: unknown } }>("/api/v1/atem/dsk/:dsk/tie", async (request, reply) => {
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
}
