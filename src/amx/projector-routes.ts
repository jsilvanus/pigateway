import type { FastifyInstance, FastifyReply } from "fastify";
import type { AmxClient } from "./amx-client.js";

const VALID_TARGETS = new Set(["proj1", "proj2"]);
const SOURCE_NAMES: Record<string, string> = {
  "11": "Computer - RGB",
  "14": "Computer - Component",
  "1F": "Computer - Auto",
  "30": "HDMI",
  "52": "USB",
  "53": "LAN",
  "80": "HDBaseT",
  "A0": "DVI-D",
  "B1": "BNC - RGB",
  "B4": "BNC - Component",
  "BF": "BNC - Auto",
};

const NAME_TO_CODE: Record<string, string> = {
  hdbaset: "80",
  hdmi: "30",
  dvi: "A0",
  lan: "53",
  computer: "1F",
  bnc: "BF",
};

function parseTarget(raw: string): "proj1" | "proj2" | null {
  const lower = raw.toLowerCase();
  if (lower === "1" || lower === "proj1") return "proj1";
  if (lower === "2" || lower === "proj2") return "proj2";
  return null;
}

export function registerProjectorRoutes(app: FastifyInstance, amxClient: AmxClient): void {
  // GET status (power status and current source)
  app.get<{ Params: { target: string } }>("/api/v1/projectors/:target", async (request, reply) => {
    const target = parseTarget(request.params.target);
    if (!target) return reply.code(422).send({ error: { code: "INVALID_TARGET", message: "Target must be proj1 or proj2" } });

    const status = await amxClient.epsonStatus(target);
    if (!status) {
      return reply.code(502).send({ error: { code: "AMX_UNAVAILABLE", message: "Could not retrieve projector status from AMX" } });
    }
    const sourceCode = status.source.toUpperCase();
    return reply.code(200).send({
      target,
      status: status.status,
      power: status.status === 1 ? "on" : status.status === 2 ? "warmup" : status.status === 3 ? "cooldown" : "standby",
      source: sourceCode || null,
      sourceName: SOURCE_NAMES[sourceCode] ?? (sourceCode ? "Unknown" : null)
    });
  });

  // POST raw command pass-through
  app.post<{ Params: { target: string }; Body: { command?: unknown } }>("/api/v1/projectors/:target/raw", async (request, reply) => {
    const target = parseTarget(request.params.target);
    if (!target) return reply.code(422).send({ error: { code: "INVALID_TARGET", message: "Target must be proj1 or proj2" } });

    const command = typeof request.body?.command === "string" ? request.body.command.trim() : "";
    if (!command) return reply.code(422).send({ error: { code: "INVALID_COMMAND", message: "command string is required" } });

    const res = await amxClient.epsonCommand(target, "RAW", command);
    if (!res.success) {
      return reply.code(502).send({ error: { code: "COMMAND_FAILED", message: res.message } });
    }
    return reply.code(200).send({ success: true, target, command });
  });

  // POST power on / off
  app.post<{ Params: { target: string }; Body: { power?: unknown } }>("/api/v1/projectors/:target/power", async (request, reply) => {
    const target = parseTarget(request.params.target);
    if (!target) return reply.code(422).send({ error: { code: "INVALID_TARGET", message: "Target must be proj1 or proj2" } });

    const power = typeof request.body?.power === "string" ? request.body.power.toUpperCase() : "";
    if (power !== "ON" && power !== "OFF") {
      return reply.code(422).send({ error: { code: "INVALID_POWER", message: "power must be 'on' or 'off'" } });
    }

    const res = await amxClient.epsonCommand(target, "POWER", power);
    if (!res.success) {
      return reply.code(502).send({ error: { code: "COMMAND_FAILED", message: res.message } });
    }
    return reply.code(200).send({ success: true, target, power: power.toLowerCase() });
  });

  // POST set source
  app.post<{ Params: { target: string }; Body: { source?: unknown } }>("/api/v1/projectors/:target/source", async (request, reply) => {
    const target = parseTarget(request.params.target);
    if (!target) return reply.code(422).send({ error: { code: "INVALID_TARGET", message: "Target must be proj1 or proj2" } });

    const rawSrc = typeof request.body?.source === "string" ? request.body.source.trim().toLowerCase() : "";
    const sourceCode = (NAME_TO_CODE[rawSrc] ?? rawSrc).toUpperCase();
    if (!SOURCE_NAMES[sourceCode]) {
      return reply.code(422).send({
        error: { code: "INVALID_SOURCE", message: `source must be one of: ${Object.keys(NAME_TO_CODE).join(", ")} or code (e.g. 80, 30)` }
      });
    }

    const res = await amxClient.epsonCommand(target, "SOURCE", sourceCode);
    if (!res.success) {
      return reply.code(502).send({ error: { code: "COMMAND_FAILED", message: res.message } });
    }
    return reply.code(200).send({
      success: true,
      target,
      source: sourceCode,
      sourceName: SOURCE_NAMES[sourceCode]
    });
  });
}
