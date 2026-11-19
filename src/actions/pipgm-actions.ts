/**
 * Shared rules for the piprogram (PiPGM) actions: what a feed, a Pi output and a control action may be, and the
 * step check for action lists made by the Canva plugin. Both the action registry (which runs the steps) and the
 * action list store (which checks a list when it is created) use these, so a list cannot hold a step that the
 * registry would read differently.
 */

export const PIPGM_FEEDS = ["PiPGM1", "PiPGM2", "PiPGM3"] as const;
export type PipgmFeed = (typeof PIPGM_FEEDS)[number];

/** The control actions of piprogram 1.0 (POST pipelines/:id/control). */
export const PIPGM_CONTROL_ACTIONS = ["next", "prev", "gotoStep", "gotoItem", "play", "pause", "stop", "restart"] as const;
export type PipgmControlAction = (typeof PIPGM_CONTROL_ACTIONS)[number];

/** The Pi's two HDMI outputs as pimatrix names them; Pi 1 feeds Atlona input 3, Pi 2 input 4. */
export const PI_OUTPUTS: Readonly<Record<string, { hdmi: string; atlonaInput: number }>> = {
  pi1: { hdmi: "hdmi0", atlonaInput: 3 },
  pi2: { hdmi: "hdmi1", atlonaInput: 4 }
};

/** Atlona outputs that are projectors (1 = left, 2 = right). */
export const PROJECTOR_OUTPUTS: readonly number[] = [1, 2];

const MAX_ITEMS = 500;

/** "PiPGM1", "pipgm1" or 1 gives "PiPGM1"; anything else null. */
export function normalizeFeed(value: unknown): PipgmFeed | null {
  const match = /^(?:pipgm)?([1-3])$/i.exec(String(value ?? "").trim());
  return match ? (`PiPGM${match[1]}` as PipgmFeed) : null;
}

/** "pi1", "Pi 1", "1" or 1 gives "pi1"; only the Pi's two outputs exist. */
export function normalizePiOutput(value: unknown): "pi1" | "pi2" | null {
  const match = /^(?:pi\s*)?([12])$/i.exec(String(value ?? "").trim());
  return match ? (`pi${match[1]}` as "pi1" | "pi2") : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export type StepCheck = { ok: true; params: Record<string, unknown> } | { ok: false; error: string };

/**
 * The steps the Canva plugin may put in an action list, with their params checked and normalised (unknown keys are
 * dropped). Anything else, cameras, encoders, the ATEM and every setup step included, is refused. A matrix route
 * may only join a Pi input (3 or 4) to a projector output (1 or 2).
 */
export function checkCanvaStep(action: string, raw: unknown): StepCheck {
  const params = raw === undefined ? {} : raw;
  if (!isRecord(params)) return { ok: false, error: "params must be an object" };
  switch (action) {
    case "pipgm:playlist-set": {
      const feed = normalizeFeed(params.feed);
      if (!feed) return { ok: false, error: "feed must be PiPGM1, PiPGM2 or PiPGM3" };
      const ids = params.itemIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ITEMS || !ids.every((id) => typeof id === "string" && id.trim() !== "")) {
        return { ok: false, error: `itemIds must be 1 to ${MAX_ITEMS} item ids` };
      }
      const out: Record<string, unknown> = { feed, itemIds: ids.map((id) => String(id).trim()) };
      if (params.name !== undefined) {
        if (typeof params.name !== "string" || !params.name.trim() || params.name.length > 120) return { ok: false, error: "name must be 1 to 120 characters" };
        out.name = params.name.trim();
      }
      return { ok: true, params: out };
    }
    case "pipgm:route": {
      const feed = normalizeFeed(params.feed);
      if (!feed) return { ok: false, error: "feed must be PiPGM1, PiPGM2 or PiPGM3" };
      const output = normalizePiOutput(params.output);
      if (!output) return { ok: false, error: "output must be pi1 or pi2" };
      return { ok: true, params: { feed, output } };
    }
    case "matrix:route": {
      const input = params.input;
      const output = params.output;
      if (typeof input !== "number" || ![3, 4].includes(input)) return { ok: false, error: "input must be 3 or 4 (Pi 1 or Pi 2)" };
      if (typeof output !== "number" || !PROJECTOR_OUTPUTS.includes(output)) return { ok: false, error: "output must be 1 or 2 (a projector)" };
      return { ok: true, params: { input, output } };
    }
    case "pipgm:ftb": {
      const feed = normalizeFeed(params.feed);
      if (!feed) return { ok: false, error: "feed must be PiPGM1, PiPGM2 or PiPGM3" };
      if (typeof params.on !== "boolean") return { ok: false, error: "on must be true or false" };
      return { ok: true, params: { feed, on: params.on } };
    }
    case "pipgm:control": {
      const feed = normalizeFeed(params.feed);
      if (!feed) return { ok: false, error: "feed must be PiPGM1, PiPGM2 or PiPGM3" };
      const control = String(params.action ?? "");
      if (!(PIPGM_CONTROL_ACTIONS as readonly string[]).includes(control)) return { ok: false, error: `action must be one of: ${PIPGM_CONTROL_ACTIONS.join(", ")}` };
      const out: Record<string, unknown> = { feed, action: control };
      if (params.stepIndex !== undefined) {
        if (!isIndex(params.stepIndex)) return { ok: false, error: "stepIndex must be a non-negative integer" };
        out.stepIndex = params.stepIndex;
      }
      if (params.itemIndex !== undefined) {
        if (!isIndex(params.itemIndex)) return { ok: false, error: "itemIndex must be a non-negative integer" };
        out.itemIndex = params.itemIndex;
      }
      if (params.itemId !== undefined) {
        if (typeof params.itemId !== "string" || !params.itemId.trim()) return { ok: false, error: "itemId must be a string" };
        out.itemId = params.itemId.trim();
      }
      if (params.entryId !== undefined) {
        if (typeof params.entryId !== "string" || !params.entryId.trim()) return { ok: false, error: "entryId must be a string" };
        out.entryId = params.entryId.trim();
      }
      return { ok: true, params: out };
    }
    default:
      return { ok: false, error: `Action '${action}' is not allowed in a list made from Canva` };
  }
}
