import type { GatewayEventBroker } from "../events.js";
import type { ActionRegistry, ActionExecutionResult } from "../actions/action-registry.js";

export type ItemStatus = "pending" | "active" | "completed" | "skipped";

export type FireTarget =
  | number
  | string
  | { line?: number | undefined; index?: number | undefined; id?: string | undefined }
  | undefined;

export interface RundownItemSummary {
  id: string;
  line: number;
  index: number;
  title: string;
  section?: string | undefined;
  notes?: string | undefined;
  status: ItemStatus;
  hasCue: boolean;
  actionCount: number;
}

export interface StoredRundownItem {
  id: string;
  title: string;
  section?: string | undefined;
  notes?: string | undefined;
  cue?: unknown | undefined;
  actions?: unknown[] | undefined;
}

export interface StoredRundownDoc {
  version?: number | undefined;
  title: string;
  service?: string | undefined;
  church?: string | undefined;
  date?: string | undefined;
  connectors?: Record<string, unknown> | undefined;
  preflight?: {
    variables?: Record<string, unknown> | undefined;
    fetch?: Array<{ connector: string; request: string }> | undefined;
  } | undefined;
  rundown: StoredRundownItem[];
}

export interface RundownStatusSnapshot {
  loaded: boolean;
  title?: string | undefined;
  service?: string | undefined;
  church?: string | undefined;
  date?: string | undefined;
  currentIndex: number;
  currentLine: number | null;
  totalItems: number;
  currentItem: RundownItemSummary | null;
  items: RundownItemSummary[];
  variables: Record<string, string>;
  history: Array<{ timestamp: string; actor: string; type: string; detail: unknown }>;
}

export interface RundownStoreOptions {
  eventBroker: GatewayEventBroker;
  actionRegistry?: ActionRegistry | undefined;
}

export class RundownStore {
  private readonly eventBroker: GatewayEventBroker;
  private actionRegistry?: ActionRegistry | undefined;

  private doc: StoredRundownDoc | null = null;
  private currentIndex = -1;
  private readonly itemStates = new Map<string, ItemStatus>();
  private readonly variables = new Map<string, string>();
  private readonly history: Array<{ timestamp: string; actor: string; type: string; detail: unknown }> = [];

  constructor(options: RundownStoreOptions) {
    this.eventBroker = options.eventBroker;
    this.actionRegistry = options.actionRegistry;
  }

  setActionRegistry(actionRegistry: ActionRegistry): void {
    this.actionRegistry = actionRegistry;
  }

  getStatus(): RundownStatusSnapshot {
    if (!this.doc) {
      return {
        loaded: false,
        currentIndex: -1,
        currentLine: null,
        totalItems: 0,
        currentItem: null,
        items: [],
        variables: Object.fromEntries(this.variables.entries()),
        history: [...this.history],
      };
    }

    const items: RundownItemSummary[] = this.doc.rundown.map((item, idx) => ({
      id: item.id,
      line: idx + 1,
      index: idx,
      title: item.title,
      section: item.section,
      notes: item.notes,
      status: this.itemStates.get(item.id) ?? "pending",
      hasCue: Boolean(item.cue),
      actionCount: item.actions?.length ?? 0,
    }));

    const currentItem =
      this.currentIndex >= 0 && this.currentIndex < items.length
        ? items[this.currentIndex] ?? null
        : null;

    const currentLine =
      this.currentIndex >= 0 && this.currentIndex < items.length
        ? this.currentIndex + 1
        : null;

    return {
      loaded: true,
      title: this.doc.title,
      service: this.doc.service,
      church: this.doc.church,
      date: this.doc.date,
      currentIndex: this.currentIndex,
      currentLine,
      totalItems: items.length,
      currentItem,
      items,
      variables: Object.fromEntries(this.variables.entries()),
      history: [...this.history],
    };
  }

  load(doc: StoredRundownDoc, actor = "unknown"): RundownStatusSnapshot {
    this.doc = doc;
    this.itemStates.clear();
    this.variables.clear();
    this.history.length = 0;

    // Load preflight variables
    if (doc.preflight?.variables) {
      for (const [key, val] of Object.entries(doc.preflight.variables)) {
        if (val !== undefined && val !== null) {
          this.variables.set(key, String(val));
        }
      }
    }

    // Initialize all items as pending
    for (const item of doc.rundown) {
      this.itemStates.set(item.id, "pending");
    }

    // Activate item 0 if rundown not empty
    if (doc.rundown.length > 0 && doc.rundown[0]) {
      this.currentIndex = 0;
      this.itemStates.set(doc.rundown[0].id, "active");
    } else {
      this.currentIndex = -1;
    }

    this.logHistory(actor, "rundown_loaded", { title: doc.title, totalItems: doc.rundown.length });
    this.emitState();
    return this.getStatus();
  }

  reset(actor = "unknown"): RundownStatusSnapshot {
    if (!this.doc) return this.getStatus();

    for (const item of this.doc.rundown) {
      this.itemStates.set(item.id, "pending");
    }

    if (this.doc.rundown.length > 0 && this.doc.rundown[0]) {
      this.currentIndex = 0;
      this.itemStates.set(this.doc.rundown[0].id, "active");
    } else {
      this.currentIndex = -1;
    }

    this.logHistory(actor, "rundown_reset", {});
    this.emitState();
    return this.getStatus();
  }

  async next(actor = "unknown"): Promise<{ advanced: boolean; rundown: RundownStatusSnapshot }> {
    if (!this.doc || this.currentIndex < 0) {
      return { advanced: false, rundown: this.getStatus() };
    }

    const current = this.getCurrentItem();
    if (current) {
      this.itemStates.set(current.id, "completed");
    }

    const nextIndex = this.currentIndex + 1;
    let advanced = false;
    if (nextIndex < this.doc.rundown.length && this.doc.rundown[nextIndex]) {
      this.currentIndex = nextIndex;
      this.itemStates.set(this.doc.rundown[nextIndex]!.id, "active");
      advanced = true;
    } else {
      this.currentIndex = this.doc.rundown.length;
      advanced = false;
    }

    this.logHistory(actor, "rundown_next", {
      fromId: current?.id,
      toId: this.getCurrentItem()?.id ?? null,
      currentIndex: this.currentIndex,
    });
    this.emitState();
    return { advanced, rundown: this.getStatus() };
  }

  previous(actor = "unknown"): { moved: boolean; rundown: RundownStatusSnapshot } {
    if (!this.doc || this.currentIndex <= 0) {
      return { moved: false, rundown: this.getStatus() };
    }

    const current = this.getCurrentItem();
    if (current) {
      this.itemStates.set(current.id, "pending");
    }

    this.currentIndex--;
    const prev = this.getCurrentItem();
    if (prev) {
      this.itemStates.set(prev.id, "active");
    }

    this.logHistory(actor, "rundown_previous", {
      fromId: current?.id,
      toId: prev?.id ?? null,
      currentIndex: this.currentIndex,
    });
    this.emitState();
    return { moved: true, rundown: this.getStatus() };
  }

  goto(id: string, actor = "unknown"): { moved: boolean; rundown: RundownStatusSnapshot } {
    if (!this.doc) return { moved: false, rundown: this.getStatus() };

    const targetIdx = this.doc.rundown.findIndex((it) => it.id === id);
    if (targetIdx === -1) return { moved: false, rundown: this.getStatus() };

    this.doc.rundown.forEach((it, idx) => {
      if (idx < targetIdx) {
        if (this.itemStates.get(it.id) === "pending") this.itemStates.set(it.id, "completed");
      } else if (idx === targetIdx) {
        this.itemStates.set(it.id, "active");
      } else {
        this.itemStates.set(it.id, "pending");
      }
    });

    this.currentIndex = targetIdx;
    this.logHistory(actor, "rundown_goto", { targetId: id, targetIndex: targetIdx });
    this.emitState();
    return { moved: true, rundown: this.getStatus() };
  }

  skip(id?: string, actor = "unknown"): { skipped: boolean; rundown: RundownStatusSnapshot } {
    if (!this.doc) return { skipped: false, rundown: this.getStatus() };

    const targetItem = id
      ? this.doc.rundown.find((it) => it.id === id)
      : this.getCurrentItem();

    if (!targetItem) return { skipped: false, rundown: this.getStatus() };

    this.itemStates.set(targetItem.id, "skipped");
    this.logHistory(actor, "item_skipped", { id: targetItem.id, title: targetItem.title });

    if (this.getCurrentItem()?.id === targetItem.id) {
      this.advancePointer(targetItem);
    } else {
      this.emitState();
    }

    return { skipped: true, rundown: this.getStatus() };
  }

  async fire(
    target?: FireTarget,
    actor = "unknown"
  ): Promise<{ ok: boolean; executed: ActionExecutionResult[]; rundown: RundownStatusSnapshot }> {
    if (!this.doc || this.doc.rundown.length === 0) {
      return { ok: false, executed: [], rundown: this.getStatus() };
    }

    let targetIndex = -1;

    if (typeof target === "number") {
      // 1-based line number (e.g. 17 -> index 16)
      targetIndex = target - 1;
    } else if (typeof target === "string") {
      const trimmed = target.trim();
      if (/^\d+$/.test(trimmed)) {
        targetIndex = parseInt(trimmed, 10) - 1;
      } else {
        targetIndex = this.doc.rundown.findIndex((it) => it.id === trimmed);
      }
    } else if (typeof target === "object" && target !== null) {
      if (typeof target.line === "number") {
        targetIndex = target.line - 1;
      } else if (typeof target.index === "number") {
        targetIndex = target.index;
      } else if (typeof target.id === "string") {
        const trimmed = target.id.trim();
        if (/^\d+$/.test(trimmed)) {
          targetIndex = parseInt(trimmed, 10) - 1;
        } else {
          targetIndex = this.doc.rundown.findIndex((it) => it.id === trimmed);
        }
      } else {
        targetIndex = this.currentIndex >= 0 ? this.currentIndex : 0;
      }
    } else {
      targetIndex = this.currentIndex >= 0 ? this.currentIndex : 0;
    }

    if (targetIndex < 0 || targetIndex >= this.doc.rundown.length) {
      return { ok: false, executed: [], rundown: this.getStatus() };
    }

    const targetItem = this.doc.rundown[targetIndex]!;

    // Move pointer TO target item and update item states:
    // Prior items (0 .. targetIndex - 1) that were pending or active become completed
    // Target item becomes active
    // Following items that were active revert to pending
    this.doc.rundown.forEach((it, idx) => {
      if (idx < targetIndex) {
        const currentStatus = this.itemStates.get(it.id);
        if (currentStatus === "pending" || currentStatus === "active") {
          this.itemStates.set(it.id, "completed");
        }
      } else if (idx === targetIndex) {
        this.itemStates.set(it.id, "active");
      } else {
        if (this.itemStates.get(it.id) === "active") {
          this.itemStates.set(it.id, "pending");
        }
      }
    });

    this.currentIndex = targetIndex;

    const executed: ActionExecutionResult[] = [];
    if (this.actionRegistry && targetItem.actions && targetItem.actions.length > 0) {
      for (const action of targetItem.actions) {
        let req: any;
        if (typeof action === "string") {
          req = { action: this.interpolate(action), actor };
        } else if (typeof action === "object" && action !== null) {
          if ("atem" in (action as any)) {
            const atem = (action as any).atem;
            if (atem.cut !== undefined) req = { action: "atem:cut", params: { input: atem.cut }, actor };
            else if (atem.auto) req = { action: "atem:auto", actor };
            else if (atem.ftb) req = { action: "atem:ftb", actor };
            else if (atem.dsk !== undefined) req = { action: "atem:dsk", params: { dskIndex: atem.dsk, state: atem.state }, actor };
          } else if ("cam" in (action as any)) {
            const cam = (action as any).cam;
            if (cam.preset !== undefined) {
              const preset = this.interpolate(String(cam.preset));
              req = { action: "cam:preset", params: { id: String(cam.id), preset: isNaN(Number(preset)) ? preset : Number(preset) }, actor };
            } else if (cam.move) {
              req = { action: "cam:move", params: { id: String(cam.id), direction: cam.move, speed: cam.speed }, actor };
            } else if (cam.zoom) {
              req = { action: "cam:zoom", params: { id: String(cam.id), action: cam.zoom, speed: cam.speed }, actor };
            }
          } else if ("tally" in (action as any)) {
            const tally = (action as any).tally;
            if (tally.cue) req = { action: "tally:cue", params: { unit: String(tally.unit), cue: this.interpolate(tally.cue) }, actor };
            else if (tally.state) req = { action: "tally:state", params: { unit: String(tally.unit), state: tally.state }, actor };
          } else if ("pipgm" in (action as any)) {
            const pipgm = (action as any).pipgm;
            if (pipgm.hymn !== undefined) req = { action: "pipgm:hymn", params: { hymn: this.interpolate(String(pipgm.hymn)) }, actor };
            else if (pipgm.slide !== undefined) req = { action: "pipgm:slide", params: { slide: this.interpolate(String(pipgm.slide)) }, actor };
          } else if ("var" in (action as any)) {
            for (const [k, v] of Object.entries((action as any).var)) {
              this.setVariable(k, this.interpolate(String(v)), actor);
            }
          } else if ("action" in (action as any)) {
            req = { ...(action as any), actor };
          }
        }

        if (req) {
          const res = await this.actionRegistry.execute(req, actor);
          executed.push(res);
        }
      }
    }

    this.logHistory(actor, "line_fired", {
      line: targetIndex + 1,
      index: targetIndex,
      id: targetItem.id,
      title: targetItem.title,
      actionCount: executed.length,
    });
    this.emitState();

    return { ok: true, executed, rundown: this.getStatus() };
  }

  setVariable(name: string, value: string, actor = "unknown"): void {
    this.variables.set(name, value);
    this.logHistory(actor, "variable_set", { name, value });
    this.emitState();
  }

  getVariables(): Record<string, string> {
    return Object.fromEntries(this.variables.entries());
  }

  getCurrentItem(): StoredRundownItem | null {
    if (!this.doc || this.currentIndex < 0 || this.currentIndex >= this.doc.rundown.length) {
      return null;
    }
    return this.doc.rundown[this.currentIndex] ?? null;
  }

  private advancePointer(item: StoredRundownItem): void {
    if (!this.doc) return;
    const currentIdx = this.doc.rundown.findIndex((it) => it.id === item.id);
    if (currentIdx >= 0) {
      const nextIdx = currentIdx + 1;
      if (nextIdx < this.doc.rundown.length && this.doc.rundown[nextIdx]) {
        this.currentIndex = nextIdx;
        this.itemStates.set(this.doc.rundown[nextIdx]!.id, "active");
      } else {
        this.currentIndex = this.doc.rundown.length;
      }
    }
    this.emitState();
  }

  private interpolate(text: string): string {
    return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
      return this.variables.get(key) ?? `{{${key}}}`;
    });
  }

  private emitState(): void {
    const snapshot = this.getStatus();
    this.eventBroker.emit({
      type: "rundown",
      data: snapshot,
    });
  }

  private logHistory(actor: string, type: string, detail: unknown): void {
    this.history.unshift({
      timestamp: new Date().toISOString(),
      actor,
      type,
      detail,
    });
    if (this.history.length > 100) {
      this.history.pop();
    }
  }
}
