import type { GatewayEventBroker } from "../events.js";
import type { ActionRegistry, ActionExecutionResult } from "../actions/action-registry.js";
import {
  buildRundownDisplay,
  type RundownDisplay,
  type DisplayLine,
  type ExecutableItem,
  type ItemStatus,
} from "./rundown-display.js";

export { ItemStatus };

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
  rundown: unknown[];
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
  totalLines: number;
  currentItem: RundownItemSummary | null;
  items: RundownItemSummary[];
  display: RundownDisplay;
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
  private currentExecutableId: string | null = null;
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
        totalLines: 0,
        currentItem: null,
        items: [],
        display: { lines: [], totalLines: 0, currentLine: null },
        variables: Object.fromEntries(this.variables.entries()),
        history: [...this.history],
      };
    }

    const { display, executableItems } = buildRundownDisplay(
      this.doc.rundown,
      this.itemStates,
      this.currentExecutableId
    );

    const execIndex = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : -1;

    const currentExec = execIndex >= 0 ? executableItems[execIndex] ?? null : null;

    const currentItem: RundownItemSummary | null = currentExec
      ? {
          id: currentExec.id,
          line: currentExec.line,
          index: execIndex,
          title: currentExec.title,
          section: currentExec.section,
          notes: currentExec.notes,
          status: this.itemStates.get(currentExec.id) ?? "pending",
          hasCue: Boolean(currentExec.cue),
          actionCount: currentExec.actions.length,
        }
      : null;

    const items: RundownItemSummary[] = executableItems.map((it, idx) => ({
      id: it.id,
      line: it.line,
      index: idx,
      title: it.title,
      section: it.section,
      notes: it.notes,
      status: this.itemStates.get(it.id) ?? "pending",
      hasCue: Boolean(it.cue),
      actionCount: it.actions.length,
    }));

    return {
      loaded: true,
      title: this.doc.title,
      service: this.doc.service,
      church: this.doc.church,
      date: this.doc.date,
      currentIndex: execIndex,
      currentLine: display.currentLine,
      totalItems: executableItems.length,
      totalLines: display.totalLines,
      currentItem,
      items,
      display,
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

    const { executableItems } = buildRundownDisplay(doc.rundown, this.itemStates);

    // Initialize executable items as pending
    for (const item of executableItems) {
      this.itemStates.set(item.id, "pending");
    }

    // Activate first executable item if rundown not empty
    if (executableItems.length > 0 && executableItems[0]) {
      this.currentExecutableId = executableItems[0].id;
      this.itemStates.set(executableItems[0].id, "active");
    } else {
      this.currentExecutableId = null;
    }

    this.logHistory(actor, "rundown_loaded", { title: doc.title, totalItems: executableItems.length });
    this.emitState();
    return this.getStatus();
  }

  reset(actor = "unknown"): RundownStatusSnapshot {
    if (!this.doc) return this.getStatus();

    const { executableItems } = buildRundownDisplay(this.doc.rundown, this.itemStates);

    for (const item of executableItems) {
      this.itemStates.set(item.id, "pending");
    }

    if (executableItems.length > 0 && executableItems[0]) {
      this.currentExecutableId = executableItems[0].id;
      this.itemStates.set(executableItems[0].id, "active");
    } else {
      this.currentExecutableId = null;
    }

    this.logHistory(actor, "rundown_reset", {});
    this.emitState();
    return this.getStatus();
  }

  async next(actor = "unknown"): Promise<{ advanced: boolean; rundown: RundownStatusSnapshot }> {
    if (!this.doc) {
      return { advanced: false, rundown: this.getStatus() };
    }

    const { executableItems } = buildRundownDisplay(this.doc.rundown, this.itemStates, this.currentExecutableId);
    if (executableItems.length === 0) {
      return { advanced: false, rundown: this.getStatus() };
    }

    const currentIdx = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : -1;

    if (currentIdx >= 0 && executableItems[currentIdx]) {
      this.itemStates.set(executableItems[currentIdx]!.id, "completed");
    }

    const nextIdx = currentIdx + 1;
    let advanced = false;
    if (nextIdx < executableItems.length && executableItems[nextIdx]) {
      this.currentExecutableId = executableItems[nextIdx]!.id;
      this.itemStates.set(executableItems[nextIdx]!.id, "active");
      advanced = true;
    } else {
      this.currentExecutableId = null;
      advanced = false;
    }

    this.logHistory(actor, "rundown_next", {
      fromId: currentIdx >= 0 ? executableItems[currentIdx]?.id : null,
      toId: this.currentExecutableId,
      currentIndex: nextIdx,
    });
    this.emitState();
    return { advanced, rundown: this.getStatus() };
  }

  previous(actor = "unknown"): { moved: boolean; rundown: RundownStatusSnapshot } {
    if (!this.doc) {
      return { moved: false, rundown: this.getStatus() };
    }

    const { executableItems } = buildRundownDisplay(this.doc.rundown, this.itemStates, this.currentExecutableId);
    if (executableItems.length === 0) {
      return { moved: false, rundown: this.getStatus() };
    }

    const currentIdx = this.currentExecutableId
      ? executableItems.findIndex((it) => it.id === this.currentExecutableId)
      : -1;

    if (currentIdx <= 0) {
      return { moved: false, rundown: this.getStatus() };
    }

    if (currentIdx < executableItems.length && executableItems[currentIdx]) {
      this.itemStates.set(executableItems[currentIdx]!.id, "pending");
    }

    const prevIdx = currentIdx - 1;
    let moved = false;
    if (prevIdx >= 0 && executableItems[prevIdx]) {
      this.currentExecutableId = executableItems[prevIdx]!.id;
      this.itemStates.set(executableItems[prevIdx]!.id, "active");
      moved = true;
    }

    this.logHistory(actor, "rundown_previous", {
      fromId: executableItems[currentIdx]?.id,
      toId: this.currentExecutableId,
      currentIndex: prevIdx,
    });
    this.emitState();
    return { moved, rundown: this.getStatus() };
  }

  goto(id: string, actor = "unknown"): { moved: boolean; rundown: RundownStatusSnapshot } {
    if (!this.doc) return { moved: false, rundown: this.getStatus() };

    const { executableItems, display } = buildRundownDisplay(this.doc.rundown, this.itemStates, this.currentExecutableId);

    let targetExec = executableItems.find((it) => it.id === id);
    if (!targetExec) {
      const line = display.lines.find((l) => l.id === id);
      if (line?.targetId) {
        targetExec = executableItems.find((it) => it.id === line.targetId);
      }
    }

    if (!targetExec) return { moved: false, rundown: this.getStatus() };

    const targetIdx = executableItems.findIndex((it) => it.id === targetExec!.id);
    executableItems.forEach((it, idx) => {
      if (idx < targetIdx) {
        if (this.itemStates.get(it.id) === "pending") this.itemStates.set(it.id, "completed");
      } else if (idx === targetIdx) {
        this.itemStates.set(it.id, "active");
      } else {
        this.itemStates.set(it.id, "pending");
      }
    });

    this.currentExecutableId = targetExec.id;
    this.logHistory(actor, "rundown_goto", { targetId: id, targetIndex: targetIdx });
    this.emitState();
    return { moved: true, rundown: this.getStatus() };
  }

  skip(id?: string, actor = "unknown"): { skipped: boolean; rundown: RundownStatusSnapshot } {
    if (!this.doc) return { skipped: false, rundown: this.getStatus() };

    const { executableItems } = buildRundownDisplay(this.doc.rundown, this.itemStates, this.currentExecutableId);

    const targetItem = id
      ? executableItems.find((it) => it.id === id)
      : this.getCurrentExecutableItem();

    if (!targetItem) return { skipped: false, rundown: this.getStatus() };

    this.itemStates.set(targetItem.id, "skipped");
    this.logHistory(actor, "item_skipped", { id: targetItem.id, title: targetItem.title });

    if (this.currentExecutableId === targetItem.id) {
      const idx = executableItems.findIndex((it) => it.id === targetItem.id);
      if (idx + 1 < executableItems.length && executableItems[idx + 1]) {
        this.currentExecutableId = executableItems[idx + 1]!.id;
        this.itemStates.set(executableItems[idx + 1]!.id, "active");
      } else {
        this.currentExecutableId = null;
      }
    }

    this.emitState();
    return { skipped: true, rundown: this.getStatus() };
  }

  async fire(
    target?: FireTarget,
    actor = "unknown"
  ): Promise<{ ok: boolean; executed: ActionExecutionResult[]; rundown: RundownStatusSnapshot }> {
    if (!this.doc || this.doc.rundown.length === 0) {
      return { ok: false, executed: [], rundown: this.getStatus() };
    }

    const { display, executableItems } = buildRundownDisplay(
      this.doc.rundown,
      this.itemStates,
      this.currentExecutableId
    );

    if (executableItems.length === 0) {
      return { ok: false, executed: [], rundown: this.getStatus() };
    }

    let targetExecItem: ExecutableItem | undefined;

    if (typeof target === "number") {
      const line = display.lines.find((l) => l.line === target);
      if (line) {
        targetExecItem = executableItems.find((it) => it.id === line.targetId);
      }
    } else if (typeof target === "string") {
      const trimmed = target.trim();
      if (/^\d+$/.test(trimmed)) {
        const lineNum = parseInt(trimmed, 10);
        const line = display.lines.find((l) => l.line === lineNum);
        if (line) {
          targetExecItem = executableItems.find((it) => it.id === line.targetId);
        }
      } else {
        const line = display.lines.find((l) => l.id === trimmed);
        const targetId = line?.targetId ?? trimmed;
        targetExecItem = executableItems.find((it) => it.id === targetId);
      }
    } else if (typeof target === "object" && target !== null) {
      if (typeof target.line === "number") {
        const line = display.lines.find((l) => l.line === target.line);
        if (line) {
          targetExecItem = executableItems.find((it) => it.id === line.targetId);
        }
      } else if (typeof target.index === "number") {
        targetExecItem = executableItems[target.index];
      } else if (typeof target.id === "string") {
        const line = display.lines.find((l) => l.id === target.id);
        const targetId = line?.targetId ?? target.id;
        targetExecItem = executableItems.find((it) => it.id === targetId);
      }
    } else {
      targetExecItem = this.getCurrentExecutableItem() ?? executableItems[0];
    }

    if (!targetExecItem) {
      return { ok: false, executed: [], rundown: this.getStatus() };
    }

    const targetIdx = executableItems.findIndex((it) => it.id === targetExecItem!.id);

    // Transition item states:
    // Prior executable items become completed
    // Target becomes active
    // Following items that were active revert to pending
    executableItems.forEach((it, idx) => {
      if (idx < targetIdx) {
        const s = this.itemStates.get(it.id);
        if (s === "pending" || s === "active") {
          this.itemStates.set(it.id, "completed");
        }
      } else if (idx === targetIdx) {
        this.itemStates.set(it.id, "active");
      } else {
        if (this.itemStates.get(it.id) === "active") {
          this.itemStates.set(it.id, "pending");
        }
      }
    });

    this.currentExecutableId = targetExecItem.id;

    // Find display line number
    const displayLine = display.lines.find((l) => l.id === targetExecItem!.id) ?? display.lines.find((l) => l.targetId === targetExecItem!.id);
    const lineNum = displayLine?.line ?? targetExecItem.line;

    const executed: ActionExecutionResult[] = [];
    if (this.actionRegistry && targetExecItem.actions && targetExecItem.actions.length > 0) {
      for (const action of targetExecItem.actions) {
        let req: any;
        if (typeof action === "string") {
          req = { action: this.interpolate(action), actor };
        } else if (typeof action === "object" && action !== null) {
          const switchObj = (action as any).switch ?? (action as any).atem;
          if (switchObj) {
            if (switchObj.cut !== undefined) req = { action: "switch:cut", params: { input: switchObj.cut }, actor };
            else if (switchObj.preview !== undefined) req = { action: "switch:preview", params: { input: switchObj.preview }, actor };
            else if (switchObj.program !== undefined) req = { action: "switch:program", params: { input: switchObj.program }, actor };
            else if (switchObj.auto) req = { action: "switch:auto", actor };
            else if (switchObj.ftb) req = { action: "switch:ftb", actor };
            else if (switchObj.dsk !== undefined) req = { action: "switch:dsk", params: { dskIndex: switchObj.dsk, state: switchObj.state }, actor };
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
      line: lineNum,
      index: targetIdx,
      id: targetExecItem.id,
      title: targetExecItem.title,
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

  getCurrentExecutableItem(): ExecutableItem | null {
    if (!this.doc || !this.currentExecutableId) return null;
    const { executableItems } = buildRundownDisplay(this.doc.rundown, this.itemStates, this.currentExecutableId);
    return executableItems.find((it) => it.id === this.currentExecutableId) ?? null;
  }

  getCurrentItem(): ExecutableItem | null {
    return this.getCurrentExecutableItem();
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
