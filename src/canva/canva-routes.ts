import type { FastifyInstance, FastifyReply } from "fastify";
import { CanvaError, pipelineIdFor, type CanvaService } from "./canva-service.js";

/** Where each Pi Program pipeline enters the Atlona (input), and what each route name means (outputs). */
const PIPELINE_INPUT: Record<string, number> = { PiPGM1: 3, PiPGM2: 4 };
/** Which Atlona input a pipeline can be sent through: its own by default, or either Pi output on request. */
const PI_INPUT: Record<string, number> = { pi1: 3, pi2: 4 };
const ROUTE_OUTPUTS: Record<string, number[]> = {
  both_projectors: [1, 2],
  landscape_screen: [3],
  all_displays: [1, 2, 3, 4]
};

export interface CanvaRoutesOptions {
  /** Routes an Atlona input to an output (the gateway's own matrix). Without it a route request is reported as not applied. */
  routeMatrix?: ((input: number, output: number) => Promise<{ success: boolean; message?: string | undefined }>) | undefined;
  matrixRoutes?: (() => Record<number, number | null>) | undefined;
  /** Mutes or opens the picture of a projector (Epson picture mute through the AMX). Without it picMute is not available. */
  setPictureMute?: ((target: "proj1" | "proj2", muted: boolean) => Promise<{ success: boolean; message?: string | undefined }>) | undefined;
}

const PROJECTORS = ["proj1", "proj2"] as const;

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof CanvaError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
  throw error;
}

export function registerCanvaRoutes(app: FastifyInstance, service: CanvaService, options: CanvaRoutesOptions = {}): void {
  /** What the plugin last asked for. The projectors do not report it back, so this is not read from them. */
  let lastPicMute: boolean | null = null;
  const applyPictureMute = async (muted: boolean): Promise<string | null> => {
    if (!options.setPictureMute) return "picture mute is not connected";
    const failures: string[] = [];
    for (const target of PROJECTORS) {
      const res = await options.setPictureMute(target, muted);
      if (!res.success) failures.push(`${target}: ${res.message ?? "failed"}`);
    }
    if (failures.length === 0) lastPicMute = muted;
    return failures.length ? failures.join("; ") : null;
  };

  // Step 1: the plugin's export URLs go in, a task comes out (202). The task shows download and preparation progress.
  app.post<{ Body: { title?: unknown; pages?: unknown; orientation?: unknown; useAt?: unknown } }>("/api/v1/canva/push", async (request, reply) => {
    try {
      const { task } = service.start(request.body ?? {});
      return reply.code(202).header("location", `/api/v1/canva/tasks/${task.taskId}`).send(task);
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Params: { taskId: string } }>("/api/v1/canva/tasks/:taskId", async (request, reply) => {
    const task = service.getTask(request.params.taskId);
    if (!task) return reply.code(404).send({ error: { code: "TASK_NOT_FOUND", message: `Unknown task: ${request.params.taskId}` } });
    return task;
  });

  // Step 2: put a ready presentation on a pipeline and route it to the displays.
  app.post<{ Body: { presentationId?: unknown; pipelineId?: unknown; matrixRoute?: unknown; unblankProjectors?: unknown; cueSlide?: unknown; piOutput?: unknown } }>(
    "/api/v1/canva/setup",
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const pipelineId = pipelineIdFor(String(body.pipelineId ?? ""));
        if (!pipelineId) return reply.code(422).send({ error: { code: "INVALID_PIPELINE", message: "pipelineId must be pipgm1, pipgm2 or pipgm3" } });
        const matrixRoute = String(body.matrixRoute ?? "none");
        if (matrixRoute !== "none" && !ROUTE_OUTPUTS[matrixRoute]) {
          return reply.code(422).send({ error: { code: "INVALID_MATRIX_ROUTE", message: "matrixRoute must be both_projectors, landscape_screen, all_displays or none" } });
        }
        const piOutput = body.piOutput === undefined || body.piOutput === null || body.piOutput === "" ? undefined : String(body.piOutput).toLowerCase();
        if (piOutput !== undefined && PI_INPUT[piOutput] === undefined) {
          return reply.code(422).send({ error: { code: "INVALID_PI_OUTPUT", message: "piOutput must be pi1 or pi2" } });
        }
        const cueSlide = body.cueSlide === undefined ? 1 : Number(body.cueSlide);
        if (!Number.isInteger(cueSlide) || cueSlide < 1) return reply.code(422).send({ error: { code: "INVALID_CUE_SLIDE", message: "cueSlide must be 1 or more" } });
        const presentation = service.getPresentation(String(body.presentationId ?? ""));
        if (!presentation) return reply.code(404).send({ error: { code: "PRESENTATION_NOT_FOUND", message: "Unknown presentationId" } });
        if (!presentation.task.ready) {
          return reply.code(409).send({ error: { code: "PRESENTATION_NOT_READY", message: `The presentation is not ready yet (${presentation.task.state})` } });
        }
        if (cueSlide > presentation.task.pageCount) {
          return reply.code(422).send({ error: { code: "INVALID_CUE_SLIDE", message: `The presentation has ${presentation.task.pageCount} slides` } });
        }

        const warnings: string[] = [];
        await service.pg("POST", `/api/v1/pipgm/pipelines/${pipelineId}/playlist`, { itemId: presentation.itemId, cueImmediately: true });
        if (cueSlide > 1) await service.pg("POST", `/api/v1/pipgm/pipelines/${pipelineId}/control`, { action: "gotoStep", stepIndex: cueSlide - 1 });

        let routed = false;
        if (matrixRoute !== "none") {
          const input = piOutput !== undefined ? PI_INPUT[piOutput] : PIPELINE_INPUT[pipelineId];
          if (!options.routeMatrix || input === undefined) {
            warnings.push(`matrixRoute ${matrixRoute} was not applied: no matrix control for ${pipelineId}`);
          } else {
            routed = true;
            for (const output of ROUTE_OUTPUTS[matrixRoute]!) {
              const res = await options.routeMatrix(input, output);
              if (!res.success) {
                routed = false;
                warnings.push(`matrix output ${output} was not routed: ${res.message ?? "failed"}`);
              }
            }
          }
        }
        if (body.unblankProjectors === true) {
          const problem = await applyPictureMute(false);
          if (problem) warnings.push(`unblankProjectors was not applied: ${problem}`);
        }

        return { success: true, pipelineId: String(body.pipelineId).toLowerCase(), matrixRoute, piOutput: piOutput ?? null, routed, picMute: lastPicMute, currentSlide: cueSlide, warnings };
      } catch (error) {
        return fail(reply, error);
      }
    }
  );

  // Step 3: live control.
  app.post<{ Body: { pipelineId?: unknown; action?: unknown; page?: unknown; enabled?: unknown; muted?: unknown } }>("/api/v1/canva/control", async (request, reply) => {
    try {
      const body = request.body ?? {};
      const pipelineId = pipelineIdFor(String(body.pipelineId ?? "pipgm1"));
      if (!pipelineId) return reply.code(422).send({ error: { code: "INVALID_PIPELINE", message: "pipelineId must be pipgm1, pipgm2 or pipgm3" } });
      const action = String(body.action ?? "");
      const base = `/api/v1/pipgm/pipelines/${pipelineId}`;
      if (action === "next" || action === "prev") {
        const state = await service.pg<{ currentStep: number }>("POST", `${base}/control`, { action });
        return { success: true, currentPage: state.currentStep + 1 };
      }
      if (action === "gotoPage") {
        const page = Number(body.page);
        if (!Number.isInteger(page) || page < 1) return reply.code(422).send({ error: { code: "INVALID_PAGE", message: "page must be 1 or more" } });
        const state = await service.pg<{ currentStep: number }>("POST", `${base}/control`, { action: "gotoStep", stepIndex: page - 1 });
        return { success: true, currentPage: state.currentStep + 1 };
      }
      if (action === "ftb") {
        if (typeof body.enabled !== "boolean") return reply.code(422).send({ error: { code: "INVALID_FTB_VALUE", message: "enabled must be a boolean" } });
        const state = await service.pg<{ fadeToBlack: boolean }>("POST", `${base}/ftb`, { fadeToBlack: body.enabled });
        return { success: true, ftb: state.fadeToBlack };
      }
      if (action === "picMute") {
        if (typeof body.muted !== "boolean") return reply.code(422).send({ error: { code: "INVALID_MUTED", message: "muted must be true or false" } });
        if (!options.setPictureMute) {
          return reply.code(501).send({ error: { code: "PIC_MUTE_NOT_AVAILABLE", message: "Projector picture mute is not connected" } });
        }
        const problem = await applyPictureMute(body.muted);
        if (problem) return reply.code(502).send({ error: { code: "PIC_MUTE_FAILED", message: problem } });
        return { success: true, muted: body.muted };
      }
      return reply.code(422).send({ error: { code: "INVALID_ACTION", message: "action must be next, prev, gotoPage, ftb or picMute" } });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get<{ Querystring: { pipelineId?: string } }>("/api/v1/canva/status", async (request, reply) => {
    const pipelineId = pipelineIdFor(request.query?.pipelineId ?? "pipgm1");
    if (!pipelineId) return reply.code(422).send({ error: { code: "INVALID_PIPELINE", message: "pipelineId must be pipgm1, pipgm2 or pipgm3" } });
    try {
      const state = await service.pg<{ currentStep: number; totalSteps: number; fadeToBlack: boolean }>("GET", `/api/v1/pipgm/pipelines/${pipelineId}`);
      const input = PIPELINE_INPUT[pipelineId];
      const routes = options.matrixRoutes?.();
      const outputs = routes && input !== undefined ? Object.entries(routes).filter(([, i]) => i === input).map(([o]) => Number(o)) : [];
      return { online: true, pipelineId: pipelineId.toLowerCase(), currentSlide: state.currentStep + 1, totalSlides: state.totalSteps, ftb: state.fadeToBlack, picMute: lastPicMute, routedOutputs: outputs };
    } catch (error) {
      if (error instanceof CanvaError && error.status === 502) return { online: false, picMute: lastPicMute, pipelineId: pipelineId.toLowerCase(), error: error.message };
      return fail(reply, error);
    }
  });
}
