import type { FastifyInstance, FastifyReply } from "fastify";
import { ActionListStore, routesProjector, validateCreate, type ActionList } from "./action-lists.js";
import type { ActionExecutionRequest, ActionExecutionResult } from "./action-registry.js";

export interface ActionListRoutesDeps {
  store: ActionListStore;
  /** Runs one step (the action registry's executor). */
  execute: (request: ActionExecutionRequest) => Promise<ActionExecutionResult>;
  /** Base URL of picontrol; the list's run link is <base>/run/<id>. Without it only `runPath` is given. */
  picontrolUrl?: string | undefined;
}

export function summarize(store: ActionListStore, list: ActionList, picontrolUrl?: string | undefined) {
  const runPath = `/run/${list.id}`;
  return {
    id: list.id,
    name: list.name,
    createdBy: list.createdBy,
    createdAt: list.createdAt,
    expiresAt: list.expiresAt,
    singleUse: list.singleUse,
    onError: list.onError,
    state: store.state(list),
    routesProjector: routesProjector(list),
    steps: list.steps,
    usedAt: list.usedAt,
    lastRun: list.lastRun,
    runPath,
    ...(picontrolUrl ? { link: `${picontrolUrl.replace(/\/+$/, "")}${runPath}` } : {})
  };
}

const notFound = (reply: FastifyReply, id: string) =>
  reply.code(404).send({ error: { code: "ACTION_LIST_NOT_FOUND", message: `Unknown action list: ${id}` } });

/**
 * The gateway's own action list API (main app; the picontrol UI listeners reach only get and run). The plugin
 * creates lists through the Canva listener instead (see canva-routes.ts), where the step allowlist applies.
 * The run route reads `x-ui-role`, which the UI forward sets; a list that routes a projector is refused for "relay".
 */
export function registerActionListRoutes(app: FastifyInstance, deps: ActionListRoutesDeps): void {
  const { store } = deps;

  app.post<{ Body: unknown }>("/api/v1/action-lists", async (request, reply) => {
    const checked = validateCreate(request.body, "any");
    if (!checked.ok) return reply.code(422).send({ error: { code: "INVALID_ACTION_LIST", message: checked.errors.join("; "), errors: checked.errors } });
    const list = store.create(checked.value, "api");
    return reply.code(201).send(summarize(store, list, deps.picontrolUrl));
  });

  app.get("/api/v1/action-lists", async () => ({ items: store.list().map((list) => summarize(store, list, deps.picontrolUrl)) }));

  app.get<{ Params: { id: string } }>("/api/v1/action-lists/:id", async (request, reply) => {
    const list = store.get(request.params.id);
    return list ? summarize(store, list, deps.picontrolUrl) : notFound(reply, request.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/action-lists/:id", async (request, reply) => {
    return store.delete(request.params.id) ? reply.code(204).send() : notFound(reply, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/v1/action-lists/:id/run", async (request, reply) => {
    const list = store.get(request.params.id);
    if (!list) return notFound(reply, request.params.id);
    if (request.headers["x-ui-role"] === "relay" && routesProjector(list)) {
      return reply.code(403).send({ error: { code: "PROJECTOR_NOT_ON_RELAY", message: "A list that routes a projector can only be run on the church network" } });
    }
    const state = store.state(list);
    if (state === "expired") return reply.code(410).send({ error: { code: "ACTION_LIST_EXPIRED", message: "This list has expired; make a new one" } });
    if (state === "used") return reply.code(409).send({ error: { code: "ACTION_LIST_USED", message: "This list has already been run" } });
    if (state === "running") return reply.code(409).send({ error: { code: "ACTION_LIST_RUNNING", message: "This list is running now" } });
    const run = await store.run(list, `actionlist:${list.id}`, deps.execute);
    request.log.info({ event: "action_list_run", listId: list.id, ok: run.ok, steps: run.steps.length, stoppedAt: run.stoppedAt }, "action list run");
    if (!run.ok) {
      const failed = run.steps[run.stoppedAt ?? 0];
      return reply.code(502).send({ error: { code: "ACTION_LIST_STEP_FAILED", message: `Step ${(run.stoppedAt ?? 0) + 1} (${failed?.action}) failed: ${failed?.error ?? "unknown error"}` }, run, list: summarize(store, list, deps.picontrolUrl) });
    }
    return { ok: true, run, list: summarize(store, list, deps.picontrolUrl) };
  });
}

/** The two routes the Canva plugin gets: make a list (allowlisted steps only) and read it. It cannot run or delete one. */
export function registerCanvaActionListRoutes(app: FastifyInstance, deps: Pick<ActionListRoutesDeps, "store" | "picontrolUrl">): void {
  const { store } = deps;

  app.post<{ Body: unknown }>("/api/v1/canva/action-lists", async (request, reply) => {
    const checked = validateCreate(request.body, "canva");
    if (!checked.ok) return reply.code(422).send({ error: { code: "INVALID_ACTION_LIST", message: checked.errors.join("; "), errors: checked.errors } });
    const list = store.create(checked.value, "canva");
    return reply.code(201).send(summarize(store, list, deps.picontrolUrl));
  });

  app.get<{ Params: { id: string } }>("/api/v1/canva/action-lists/:id", async (request, reply) => {
    const list = store.get(request.params.id);
    return list ? summarize(store, list, deps.picontrolUrl) : notFound(reply, request.params.id);
  });
}
