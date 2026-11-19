/**
 * Saved action lists: an ordered set of registry actions that is stored under a uuid and run later with one call.
 * The Canva plugin makes one when the user presses "Go live" and picontrol runs it (on the church LAN, once,
 * within a short time). The gateway owns them because it already owns the action registry and who may call it.
 *
 * A list is data, not a script: every step is an action id with params, run in order by the same executor as
 * POST /api/v1/actions/execute, and the run stops at the first step that fails (`onError: "stop"`).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCanvaStep } from "./pipgm-actions.js";
import type { ActionExecutionRequest, ActionExecutionResult } from "./action-registry.js";

export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 24 * 60 * 60;
export const MAX_STEPS = 20;
export const MAX_LISTS = 200;
const MAX_NAME = 120;

export interface ActionListStep {
  action: string;
  params?: Record<string, unknown>;
}

export interface ActionList {
  id: string;
  name: string;
  /** Who made it: "canva" (the plugin) or "api". Set by the listener, never by the caller. */
  createdBy: "canva" | "api";
  createdAt: string;
  expiresAt: string;
  singleUse: boolean;
  steps: ActionListStep[];
  onError: "stop";
  /** When a run last started and completed; null until then. A failed run clears it so the list can be retried. */
  usedAt: string | null;
  lastRun: ActionListRun | null;
}

export interface ActionListRun {
  at: string;
  actor: string;
  ok: boolean;
  steps: Array<{ action: string; ok: boolean; error?: string | undefined }>;
  /** Index of the step that failed; the steps after it were not run. */
  stoppedAt?: number | undefined;
}

export type CreateCheck = { ok: true; value: Pick<ActionList, "name" | "steps" | "singleUse"> & { ttlSeconds: number } } | { ok: false; errors: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks a create request. `restrictTo: "canva"` refuses every step outside the plugin's allowlist and normalises
 * the params of the ones it allows; `"any"` (the gateway's own API) accepts any action id with object params and
 * leaves the actual check to the executor at run time.
 */
export function validateCreate(input: unknown, restrictTo: "canva" | "any"): CreateCheck {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["body must be an object"] };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("name is required");
  else if (name.length > MAX_NAME) errors.push(`name is at most ${MAX_NAME} characters`);
  const steps: ActionListStep[] = [];
  if (!Array.isArray(input.steps) || input.steps.length === 0) errors.push("steps must be a non-empty array");
  else if (input.steps.length > MAX_STEPS) errors.push(`a list has at most ${MAX_STEPS} steps`);
  else {
    input.steps.forEach((raw, i) => {
      if (!isRecord(raw) || typeof raw.action !== "string" || !raw.action.trim()) return void errors.push(`steps[${i}].action is required`);
      const action = raw.action.trim();
      if (restrictTo === "canva") {
        const checked = checkCanvaStep(action, raw.params);
        if (!checked.ok) return void errors.push(`steps[${i}]: ${checked.error}`);
        steps.push({ action, params: checked.params });
        return;
      }
      if (raw.params !== undefined && !isRecord(raw.params)) return void errors.push(`steps[${i}].params must be an object`);
      steps.push({ action, params: isRecord(raw.params) ? raw.params : {} });
    });
  }
  if (input.onError !== undefined && input.onError !== "stop") errors.push('onError must be "stop"');
  if (input.singleUse !== undefined && typeof input.singleUse !== "boolean") errors.push("singleUse must be true or false");
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (input.ttlSeconds !== undefined) {
    const n = input.ttlSeconds;
    if (typeof n === "number" && Number.isFinite(n) && n >= 30 && n <= MAX_TTL_SECONDS) ttlSeconds = Math.floor(n);
    else errors.push(`ttlSeconds must be from 30 to ${MAX_TTL_SECONDS}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, steps, singleUse: input.singleUse !== false, ttlSeconds } };
}

/** True when running the list would route a projector (any matrix step). The internet relay may not run such a list. */
export function routesProjector(list: Pick<ActionList, "steps">): boolean {
  return list.steps.some((step) => step.action.toLowerCase().startsWith("matrix:"));
}

export interface ActionListStoreOptions {
  /** Where lists are kept as <id>.json. Without it they live in memory only (a restart forgets them). */
  dir?: string | undefined;
  now?: () => number;
}

export class ActionListStore {
  readonly #lists = new Map<string, ActionList>();
  readonly #dir: string | undefined;
  readonly #now: () => number;
  readonly #running = new Set<string>();

  constructor(options: ActionListStoreOptions = {}) {
    this.#dir = options.dir;
    this.#now = options.now ?? Date.now;
    if (this.#dir) {
      mkdirSync(this.#dir, { recursive: true });
      for (const file of readdirSync(this.#dir)) {
        if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
        try {
          const list = JSON.parse(readFileSync(join(this.#dir, file), "utf8")) as ActionList;
          if (list.id === file.slice(0, -5)) this.#lists.set(list.id, list);
        } catch {
          // an unreadable file is left alone
        }
      }
      this.prune();
    }
  }

  expired(list: ActionList): boolean {
    return Date.parse(list.expiresAt) <= this.#now();
  }

  /** Drops expired lists, and the oldest ones beyond MAX_LISTS. */
  prune(): void {
    for (const list of [...this.#lists.values()]) if (this.expired(list)) this.#remove(list.id);
    const extra = this.#lists.size - MAX_LISTS;
    if (extra > 0) {
      const oldest = [...this.#lists.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, extra);
      for (const list of oldest) this.#remove(list.id);
    }
  }

  create(value: { name: string; steps: ActionListStep[]; singleUse: boolean; ttlSeconds: number }, createdBy: ActionList["createdBy"]): ActionList {
    this.prune();
    const now = this.#now();
    const list: ActionList = {
      id: randomUUID(),
      name: value.name,
      createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + value.ttlSeconds * 1000).toISOString(),
      singleUse: value.singleUse,
      steps: value.steps,
      onError: "stop",
      usedAt: null,
      lastRun: null
    };
    this.#lists.set(list.id, list);
    this.#persist(list);
    return list;
  }

  /** The list, including an expired one that has not been pruned yet (the caller checks `expired`). */
  get(id: string): ActionList | null {
    return this.#lists.get(id) ?? null;
  }

  list(): ActionList[] {
    this.prune();
    return [...this.#lists.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  delete(id: string): boolean {
    return this.#remove(id);
  }

  /** Can it be run now: not expired, not used (when single use), and not running. */
  state(list: ActionList): "ready" | "expired" | "used" | "running" {
    if (this.expired(list)) return "expired";
    if (this.#running.has(list.id)) return "running";
    if (list.singleUse && list.usedAt) return "used";
    return "ready";
  }

  /**
   * Runs the steps in order with `execute`, stopping at the first one that fails. The list counts as used from the
   * start (two quick taps cannot run it twice) and is released again when a step fails, so the same link can retry.
   * The caller has checked `state` is "ready".
   */
  async run(list: ActionList, actor: string, execute: (request: ActionExecutionRequest) => Promise<ActionExecutionResult>): Promise<ActionListRun> {
    this.#running.add(list.id);
    list.usedAt = new Date(this.#now()).toISOString();
    const run: ActionListRun = { at: list.usedAt, actor, ok: true, steps: [] };
    try {
      for (const [index, step] of list.steps.entries()) {
        let result: ActionExecutionResult;
        try {
          result = await execute({ action: step.action, params: step.params ?? {}, actor });
        } catch (err) {
          result = { ok: false, action: step.action, actor, error: err instanceof Error ? err.message : String(err) };
        }
        run.steps.push({ action: step.action, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
        if (!result.ok) {
          run.ok = false;
          run.stoppedAt = index;
          break;
        }
      }
    } finally {
      this.#running.delete(list.id);
    }
    if (!run.ok) list.usedAt = null;
    list.lastRun = run;
    this.#persist(list);
    return run;
  }

  #persist(list: ActionList): void {
    if (!this.#dir) return;
    try {
      writeFileSync(join(this.#dir, `${list.id}.json`), JSON.stringify(list));
    } catch {
      // The list still works from memory; it just will not survive a restart.
    }
  }

  #remove(id: string): boolean {
    const had = this.#lists.delete(id);
    if (had && this.#dir) {
      try {
        rmSync(join(this.#dir, `${id}.json`), { force: true });
      } catch {
        // nothing to clean
      }
    }
    return had;
  }
}
