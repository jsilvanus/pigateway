import type { AtemAdapter } from "../atem/atem-adapter.js";
import type { CameraService } from "../camera/camera-service.js";
import type { EncoderService } from "../encoder/encoder-service.js";
import type { AtlonaMatrix } from "../amx/atlona.js";
import type { EcosystemTracker } from "../ecosystem/ecosystem-tracker.js";
import type { GatewayEventBroker } from "../events.js";
import type { AppConfig } from "../config.js";
import type { PanTiltDirection, ZoomAction } from "../camera/visca-protocol.js";
import type { RundownStore } from "../rundown/rundown-store.js";
import { VideoSourceRegistry } from "../switcher/video-source-registry.js";

export interface ActionParamDef {
  type: "string" | "number" | "boolean" | "object";
  required?: boolean | undefined;
  description?: string | undefined;
  enum?: Array<string | number> | undefined;
}

export interface ActionDefinition {
  id: string;
  domain: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string | undefined;
  params: Record<string, ActionParamDef>;
}

export interface ActionExecutionRequest {
  action: string;
  actor?: string | undefined;
  params?: Record<string, unknown> | undefined;
}

export interface ActionExecutionResult {
  ok: boolean;
  action: string;
  actor: string;
  target?: string | undefined;
  result?: unknown | undefined;
  error?: string | undefined;
}

export interface ActionRegistryOptions {
  config: AppConfig;
  atem: AtemAdapter;
  cameraService: CameraService;
  encoder: EncoderService;
  matrix: AtlonaMatrix;
  ecosystemTracker: EcosystemTracker;
  eventBroker: GatewayEventBroker;
  fetchFn?: typeof fetch | undefined;
  rundownStore?: RundownStore | undefined;
  sourceRegistry?: VideoSourceRegistry | undefined;
}

export class ActionRegistry {
  private readonly config: AppConfig;
  private readonly atem: AtemAdapter;
  private readonly cameraService: CameraService;
  private readonly encoder: EncoderService;
  private readonly matrix: AtlonaMatrix;
  private readonly ecosystemTracker: EcosystemTracker;
  private readonly eventBroker: GatewayEventBroker;
  private readonly fetchFn: typeof fetch;
  readonly sourceRegistry: VideoSourceRegistry;
  private rundownStore?: RundownStore | undefined;

  constructor(options: ActionRegistryOptions) {
    this.config = options.config;
    this.atem = options.atem;
    this.cameraService = options.cameraService;
    this.encoder = options.encoder;
    this.matrix = options.matrix;
    this.ecosystemTracker = options.ecosystemTracker;
    this.eventBroker = options.eventBroker;
    this.fetchFn = options.fetchFn ?? fetch;
    this.rundownStore = options.rundownStore;
    this.sourceRegistry =
      options.sourceRegistry ??
      new VideoSourceRegistry({ switchMatrixInput: options.config.switchMatrixInput });
  }

  setRundownStore(store: RundownStore): void {
    this.rundownStore = store;
  }

  /**
   * Returns catalog of actions with dynamic availability based on established services/devices.
   */
  listActions(availableOnly = false): ActionDefinition[] {
    const ecosystem = this.ecosystemTracker.getSummary();
    const actions: ActionDefinition[] = [];

    // 1. Switch / Video Mixer Actions (primary: switch, alias: atem, piswitch)
    const switchConnected = this.atem.getState().connected;
    const switchReason = switchConnected ? undefined : "Video switch is not connected";

    actions.push({
      id: "switch:cut",
      domain: "switch",
      name: "Switch Cut",
      description: "Direct cut transition to an input, or cut preview to program",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {
        input: { type: "number", required: false, description: "Optional input number to set on preview before cut" },
      },
    });

    actions.push({
      id: "switch:preview",
      domain: "switch",
      name: "Switch Set Preview",
      description: "Select video source on the preview bus",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {
        input: { type: "number", required: true, description: "Video input number (e.g. 1-8)" },
      },
    });

    actions.push({
      id: "switch:program",
      domain: "switch",
      name: "Switch Set Program",
      description: "Directly select video source on the program bus",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {
        input: { type: "number", required: true, description: "Video input number (e.g. 1-8)" },
      },
    });

    actions.push({
      id: "switch:auto",
      domain: "switch",
      name: "Switch Auto Transition",
      description: "Perform mix/auto transition between preview and program",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {},
    });

    actions.push({
      id: "switch:ftb",
      domain: "switch",
      name: "Switch Fade To Black",
      description: "Toggle fade to black transition",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {},
    });

    actions.push({
      id: "switch:dsk",
      domain: "switch",
      name: "Switch Downstream Keyer",
      description: "Control DSK overlay on air or tie state",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {
        dskIndex: { type: "number", required: true, description: "DSK index (0 or 1)" },
        state: { type: "string", required: false, enum: ["on", "off", "toggle"] },
      },
    });

    // ATEM aliases for backward compatibility
    actions.push({
      id: "atem:cut",
      domain: "atem",
      name: "ATEM Cut",
      description: "Alias for switch:cut",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {
        input: { type: "number", required: false, description: "Optional input number to set on preview before cut" },
      },
    });

    actions.push({
      id: "atem:preview",
      domain: "atem",
      name: "ATEM Set Preview",
      description: "Alias for switch:preview",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {
        input: { type: "number", required: true, description: "Video input number (e.g. 1-8)" },
      },
    });

    actions.push({
      id: "atem:auto",
      domain: "atem",
      name: "ATEM Auto Transition",
      description: "Alias for switch:auto",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {},
    });

    actions.push({
      id: "atem:ftb",
      domain: "atem",
      name: "ATEM Fade To Black",
      description: "Alias for switch:ftb",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {},
    });

    actions.push({
      id: "atem:dsk",
      domain: "atem",
      name: "ATEM Downstream Keyer",
      description: "Alias for switch:dsk",
      available: switchConnected,
      unavailableReason: switchReason,
      params: {
        dskIndex: { type: "number", required: true, description: "DSK index (0 or 1)" },
        state: { type: "string", required: false, enum: ["on", "off", "toggle"] },
      },
    });

    // 2. Camera Actions
    const cameras = this.cameraService.list();
    const camerasAvailable = cameras.length > 0;
    const cameraIds = cameras.map((c) => c.id);

    actions.push({
      id: "cam:preset",
      domain: "camera",
      name: "Camera Preset Recall",
      description: "Recall PTZ camera position preset",
      available: camerasAvailable,
      unavailableReason: camerasAvailable ? undefined : "No cameras configured or connected",
      params: {
        id: { type: "string", required: true, enum: cameraIds, description: "Camera identifier" },
        preset: { type: "number", required: true, description: "Preset number" },
      },
    });

    actions.push({
      id: "cam:move",
      domain: "camera",
      name: "Camera Move",
      description: "Drive PTZ camera in direction or stop",
      available: camerasAvailable,
      unavailableReason: camerasAvailable ? undefined : "No cameras configured or connected",
      params: {
        id: { type: "string", required: true, enum: cameraIds },
        direction: { type: "string", required: true, enum: ["up", "down", "left", "right", "stop"] },
        speed: { type: "number", required: false },
      },
    });

    actions.push({
      id: "cam:zoom",
      domain: "camera",
      name: "Camera Zoom",
      description: "Zoom PTZ camera lens in or out or stop",
      available: camerasAvailable,
      unavailableReason: camerasAvailable ? undefined : "No cameras configured or connected",
      params: {
        id: { type: "string", required: true, enum: cameraIds },
        action: { type: "string", required: true, enum: ["in", "out", "stop"] },
        speed: { type: "number", required: false },
      },
    });

    actions.push({
      id: "cam:smartframe",
      domain: "camera",
      name: "Camera SmartFrame Auto-Tracking",
      description: "Toggle AVer SmartFrame auto-framing on camera",
      available: camerasAvailable,
      unavailableReason: camerasAvailable ? undefined : "No cameras configured or connected",
      params: {
        id: { type: "string", required: true, enum: cameraIds },
        enabled: { type: "boolean", required: true },
      },
    });

    // 3. Matrix / Routing Actions
    const matrixComponent = ecosystem.components.pimatrix;
    const matrixAvailable = Boolean(matrixComponent?.available || matrixComponent?.active);
    const matrixReason = matrixAvailable ? undefined : "Video matrix (AMX/Atlona) is not available";

    actions.push({
      id: "matrix:route",
      domain: "matrix",
      name: "Route Matrix Input to Output",
      description: "Switch Atlona video matrix route",
      available: matrixAvailable,
      unavailableReason: matrixReason,
      params: {
        input: { type: "number", required: true, description: "Input 1-4" },
        output: { type: "number", required: true, description: "Output 1-4" },
      },
    });

    // 4. Encoder Actions
    const encoderState = this.encoder.getState();
    const encoderAvailable = Boolean(encoderState.connected);
    const encoderReason = encoderAvailable ? undefined : "Matrox Monarch HDX encoder is not connected";

    actions.push({
      id: "encoder:start",
      domain: "encoder",
      name: "Start Encoder Streaming/Recording",
      description: "Start Matrox Monarch HDX encoding stream",
      available: encoderAvailable,
      unavailableReason: encoderReason,
      params: {
        target: { type: "string", required: false, enum: ["encoder1", "encoder2", "all"] },
      },
    });

    actions.push({
      id: "encoder:stop",
      domain: "encoder",
      name: "Stop Encoder Streaming/Recording",
      description: "Stop Matrox Monarch HDX encoding stream",
      available: encoderAvailable,
      unavailableReason: encoderReason,
      params: {
        target: { type: "string", required: false, enum: ["encoder1", "encoder2", "all"] },
      },
    });

    // 5. Tally Actions (forwarded to PiLight)
    const pilightComponent = ecosystem.components.pilight;
    const pilightAvailable = Boolean(pilightComponent?.available || pilightComponent?.active || this.config.pilightApiUrl);
    const pilightReason = pilightAvailable ? undefined : "PiLight tally service is not available";

    actions.push({
      id: "tally:cue",
      domain: "tally",
      name: "Camera Director Tally Cue",
      description: "Direct camera operator via rear tally LEDs (pan-left, zoom-in, call)",
      available: pilightAvailable,
      unavailableReason: pilightReason,
      params: {
        unit: { type: "string", required: true, description: "Tally light unit ID (e.g. tally01 or 1)" },
        cue: { type: "string", required: true, enum: ["pan-left", "pan-right", "zoom-in", "zoom-out", "operator-call", "clear"] },
      },
    });

    actions.push({
      id: "tally:state",
      domain: "tally",
      name: "Set Tally State",
      description: "Set solid Program, Preview, or Off state on tally light",
      available: pilightAvailable,
      unavailableReason: pilightReason,
      params: {
        unit: { type: "string", required: true },
        state: { type: "string", required: true, enum: ["pgm", "prv", "off"] },
      },
    });

    // 6. Presentation / Slides Actions (forwarded to PiProgram)
    const pipgmComponent = ecosystem.components.piprogram;
    const pipgmAvailable = Boolean(pipgmComponent?.available || pipgmComponent?.active || this.config.piprogramApiUrl);
    const pipgmReason = pipgmAvailable ? undefined : "PiProgram presentation service is not available";

    actions.push({
      id: "pipgm:hymn",
      domain: "program",
      name: "Display Hymn Slide",
      description: "Trigger presentation slide for hymn number",
      available: pipgmAvailable,
      unavailableReason: pipgmReason,
      params: {
        hymn: { type: "string", required: true, description: "Hymn number (e.g. 332)" },
      },
    });

    actions.push({
      id: "pipgm:slide",
      domain: "program",
      name: "Display Slide Item",
      description: "Switch to specific presentation slide ID",
      available: pipgmAvailable,
      unavailableReason: pipgmReason,
      params: {
        slide: { type: "string", required: true, description: "Slide ID or index" },
      },
    });

    // 7. Rundown Actions (forwarded to PiRundown)
    const pirundownComponent = ecosystem.components.pirundown;
    const pirundownAvailable = Boolean(pirundownComponent?.available || pirundownComponent?.active || this.config.pirundownApiUrl || this.config.mode === "simulation");
    const pirundownReason = pirundownAvailable ? undefined : "PiRundown cue engine service is not available";

    actions.push({
      id: "rundown:cues",
      domain: "rundown",
      name: "Toggle / Set Cue Engine",
      description: "Toggle, enable, or disable automatic cue matching (pure human control mode)",
      available: pirundownAvailable,
      unavailableReason: pirundownReason,
      params: {
        state: { type: "string", required: false, enum: ["on", "off", "toggle"], description: "Desired state (on, off, toggle)" },
        enabled: { type: "boolean", required: false, description: "Direct boolean flag" },
      },
    });

    const rundownLoaded = Boolean(this.rundownStore?.getStatus().loaded);
    const rundownReason = rundownLoaded ? undefined : "No rundown document loaded";

    actions.push({
      id: "rundown:next",
      domain: "rundown",
      name: "Advance Rundown",
      description: "Step rundown to next item",
      available: rundownLoaded,
      unavailableReason: rundownReason,
      params: {},
    });

    actions.push({
      id: "rundown:prev",
      domain: "rundown",
      name: "Previous Rundown Item",
      description: "Step rundown back to previous item",
      available: rundownLoaded,
      unavailableReason: rundownReason,
      params: {},
    });

    actions.push({
      id: "rundown:fire",
      domain: "rundown",
      name: "Fire Rundown Item / Line",
      description: "Execute actions for item (by line number, index, or ID) and move pointer there",
      available: rundownLoaded,
      unavailableReason: rundownReason,
      params: {
        line: { type: "number", required: false, description: "1-based line number (e.g. 17)" },
        id: { type: "string", required: false, description: "Item ID (e.g. saarna)" },
        index: { type: "number", required: false, description: "0-based index" },
      },
    });

    actions.push({
      id: "rundown:reset",
      domain: "rundown",
      name: "Reset Rundown",
      description: "Reset rundown to beginning",
      available: rundownLoaded,
      unavailableReason: rundownReason,
      params: {},
    });

    // 8. Graphics Domain (PiGraphics)
    const graphicsComponent = ecosystem.components.pigraphics;
    const graphicsAvailable = Boolean(graphicsComponent?.available || graphicsComponent?.active || this.config.pigraphicsApiUrl);
    const graphicsReason = graphicsAvailable ? undefined : "PiGraphics engine is not available";

    actions.push({
      id: "graphics:show",
      domain: "graphics",
      name: "Show Graphic",
      description: "Trigger on-air lower third or graphic overlay",
      available: graphicsAvailable,
      unavailableReason: graphicsReason,
      params: {
        templateId: { type: "string", required: true, description: "Template ID (e.g. lower-third-speaker)" },
        data: { type: "object", required: false, description: "Template variable fields" },
        durationMs: { type: "number", required: false, description: "Auto-hide timeout in milliseconds" },
      },
    });

    actions.push({
      id: "graphics:hide",
      domain: "graphics",
      name: "Hide Graphic",
      description: "Take graphic instance off air",
      available: graphicsAvailable,
      unavailableReason: graphicsReason,
      params: {
        id: { type: "string", required: true, description: "Active graphic instance ID" },
      },
    });

    actions.push({
      id: "graphics:clear",
      domain: "graphics",
      name: "Clear Graphics",
      description: "Take all active graphics off air immediately",
      available: graphicsAvailable,
      unavailableReason: graphicsReason,
      params: {},
    });

    if (availableOnly) {
      return actions.filter((a) => a.available);
    }

    return actions;
  }

  /**
   * Executes a requested action across the established hardware or peer services.
   */
  async execute(request: ActionExecutionRequest | string, defaultActor = "unknown"): Promise<ActionExecutionResult> {
    let actionId: string;
    let params: Record<string, unknown>;
    let actor: string;

    if (typeof request === "string") {
      const parsed = this.parseStringAction(request);
      actionId = parsed.action;
      params = parsed.params ?? {};
      actor = defaultActor;
    } else if (typeof request.action === "string" && request.action.includes(":") && (!request.params || Object.keys(request.params).length === 0)) {
      const parsed = this.parseStringAction(request.action);
      actionId = parsed.action;
      params = parsed.params ?? {};
      actor = request.actor?.trim() || defaultActor;
    } else {
      actionId = request.action;
      params = request.params ?? {};
      actor = request.actor?.trim() || defaultActor;
    }

    let routeResult: { ok: boolean; target?: string | undefined; result?: unknown | undefined; error?: string | undefined };
    try {
      routeResult = await this.routeAction(actionId, params);
    } catch (err) {
      routeResult = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const result: ActionExecutionResult = {
      ok: routeResult.ok,
      action: actionId,
      actor,
      target: routeResult.target,
      result: routeResult.result,
      error: routeResult.error,
    };

    this.eventBroker.emit({
      type: "action",
      data: {
        actor,
        action: actionId,
        params,
        ok: result.ok,
        target: result.target,
        error: result.error,
        timestamp: new Date().toISOString(),
      },
    });

    return result;
  }

  private async routeAction(
    actionId: string,
    params: Record<string, unknown>
  ): Promise<{ ok: boolean; action?: string; target?: string | undefined; result?: unknown | undefined; error?: string | undefined }> {
    const parts = actionId.split(":");
    const domain = parts[0]?.toLowerCase();
    const op = parts[1]?.toLowerCase();

    // 1. Switch / Video Mixer Domain (primary: switch, alias: atem, piswitch)
    if (domain === "switch" || domain === "atem" || domain === "piswitch") {
      const switchState = this.atem.getState();
      if (!switchState.connected && this.config.mode !== "simulation") {
        return { ok: false, action: actionId, error: "Video switch is not connected" };
      }

      if (op === "cut" || op === "preview" || op === "program") {
        const rawInput = params.input !== undefined ? params.input : params.source;
        let mixerInput: number | undefined;
        let matrixResult: unknown = undefined;
        let resolvedSource: unknown = undefined;

        if (rawInput !== undefined) {
          const resolved = this.sourceRegistry.resolve(rawInput as string | number);
          mixerInput = resolved.mixerInput;
          resolvedSource = resolved.source;

          // If source requires matrix routing (e.g. pastorphone on Atlona 4 -> output 5)
          if (resolved.matrixRoute) {
            const { input: matIn, output: matOut } = resolved.matrixRoute;
            const routeRes = await this.matrix.route(matIn, matOut, this.config.mode);
            matrixResult = {
              routed: true,
              atlonaInput: matIn,
              atlonaOutput: matOut,
              message: routeRes.message,
            };
          }
        }

        if (op === "cut") {
          if (mixerInput !== undefined) {
            await this.atem.setPreview(mixerInput);
          }
          await this.atem.cut();
          return {
            ok: true,
            action: actionId,
            target: `${domain}:cut`,
            result: { input: mixerInput, source: (resolvedSource as any)?.id, matrix: matrixResult },
          };
        }

        if (op === "preview") {
          const targetInput = mixerInput ?? 1;
          await this.atem.setPreview(targetInput);
          return {
            ok: true,
            action: actionId,
            target: `${domain}:preview`,
            result: { input: targetInput, source: (resolvedSource as any)?.id, matrix: matrixResult },
          };
        }

        if (op === "program") {
          const targetInput = mixerInput ?? 1;
          await this.atem.setProgram(targetInput);
          return {
            ok: true,
            action: actionId,
            target: `${domain}:program`,
            result: { input: targetInput, source: (resolvedSource as any)?.id, matrix: matrixResult },
          };
        }
      }

      if (op === "auto") {
        await this.atem.autoTransition();
        return { ok: true, action: actionId, target: `${domain}:auto` };
      }

      if (op === "ftb") {
        await this.atem.fadeToBlack();
        return { ok: true, action: actionId, target: `${domain}:ftb` };
      }

      if (op === "dsk") {
        const dsk = typeof params.dskIndex === "number" ? params.dskIndex : 0;
        const state = String(params.state ?? "toggle");
        if (state === "on") await this.atem.setDownstreamKeyOnAir(dsk, true);
        else if (state === "off") await this.atem.setDownstreamKeyOnAir(dsk, false);
        else {
          const current = switchState.downstreamKeyers?.[dsk]?.onAir ?? false;
          await this.atem.setDownstreamKeyOnAir(dsk, !current);
        }
        return { ok: true, action: actionId, target: `${domain}:dsk`, result: { dsk, state } };
      }
    }

    // 2. Camera Domain
    if (domain === "cam" || domain === "camera") {
      let camId = String(params.id ?? "cam1");
      if (camId === "1") camId = "cam1";
      if (camId === "2") camId = "cam2";

      if (op === "preset") {
        const presetNum = typeof params.preset === "number" ? params.preset : parseInt(String(params.preset ?? "1"), 10) || 1;
        await this.cameraService.recallPreset(camId, presetNum);
        return { ok: true, action: actionId, target: `camera:${camId}:preset`, result: { camId, preset: presetNum } };
      }

      if (op === "move") {
        const dir = String(params.direction ?? "stop") as PanTiltDirection;
        await this.cameraService.move(camId, dir);
        return { ok: true, action: actionId, target: `camera:${camId}:move`, result: { camId, dir } };
      }

      if (op === "zoom") {
        const zoom = String(params.action ?? "stop") as ZoomAction;
        await this.cameraService.zoom(camId, zoom);
        return { ok: true, action: actionId, target: `camera:${camId}:zoom`, result: { camId, zoom } };
      }

      if (op === "smartframe") {
        const enabled = Boolean(params.enabled);
        await this.cameraService.setSmartFrame(camId, enabled ? "enable" : "disable");
        return { ok: true, action: actionId, target: `camera:${camId}:smartframe`, result: { camId, enabled } };
      }
    }

    // 3. Matrix Domain
    if (domain === "matrix") {
      if (op === "route") {
        const input = Number(params.input ?? 1);
        const output = Number(params.output ?? 1);
        const res = await this.matrix.route(input, output, this.config.mode);
        if (!res.success) {
          return { ok: false, action: actionId, error: res.message ?? "Matrix route failed" };
        }
        return { ok: true, action: actionId, target: "matrix:route", result: { input, output } };
      }
    }

    // 4. Encoder Domain
    if (domain === "encoder") {
      let encTarget: 1 | 2 | "both" = "both";
      if (params.target === "1" || params.target === 1 || params.target === "encoder1") encTarget = 1;
      else if (params.target === "2" || params.target === 2 || params.target === "encoder2") encTarget = 2;

      if (op === "start") {
        await this.encoder.startEncoder(encTarget);
        return { ok: true, action: actionId, target: "encoder:start", result: { target: encTarget } };
      }
      if (op === "stop") {
        await this.encoder.stopEncoder(encTarget);
        return { ok: true, action: actionId, target: "encoder:stop", result: { target: encTarget } };
      }
    }

    // 5. Tally Domain (forward to PiLight)
    if (domain === "tally") {
      const baseUrl = this.config.pilightApiUrl ?? "http://127.0.0.1:3200";
      const unit = encodeURIComponent(String(params.unit ?? "1"));

      if (op === "cue") {
        const cue = encodeURIComponent(String(params.cue ?? "clear"));
        const res = await this.postJson(`${baseUrl}/api/v1/tally/cue/${unit}/${cue}`, {});
        return { ok: res.ok, action: actionId, target: "tally:cue", result: res.data, error: res.error };
      }

      if (op === "state") {
        const state = String(params.state ?? "off");
        const res = await this.postJson(`${baseUrl}/api/v1/tally/${unit}/state`, { state });
        return { ok: res.ok, action: actionId, target: "tally:state", result: res.data, error: res.error };
      }
    }

    // 6. Presentation / PiPGM Domain (forward to PiProgram)
    if (domain === "pipgm" || domain === "program") {
      const baseUrl = this.config.piprogramApiUrl ?? "http://127.0.0.1:3100";

      if (op === "hymn") {
        const hymn = encodeURIComponent(String(params.hymn ?? ""));
        const res = await this.postJson(`${baseUrl}/api/v1/pipgm/hymn/${hymn}`, {});
        return { ok: res.ok, action: actionId, target: "pipgm:hymn", result: res.data, error: res.error };
      }

      if (op === "slide") {
        const slide = encodeURIComponent(String(params.slide ?? ""));
        const res = await this.postJson(`${baseUrl}/api/v1/pipgm/slide/${slide}`, {});
        return { ok: res.ok, action: actionId, target: "pipgm:slide", result: res.data, error: res.error };
      }
    }

    // 7. Rundown Domain (forward to PiRundown)
    if (domain === "rundown") {
      const baseUrl = this.config.pirundownApiUrl ?? "http://127.0.0.1:3400";

      if (op === "cues" || op === "cue") {
        let targetEnabled: boolean | undefined;
        if (typeof params.enabled === "boolean") {
          targetEnabled = params.enabled;
        } else if (params.state === "on" || params.state === "enable") {
          targetEnabled = true;
        } else if (params.state === "off" || params.state === "disable") {
          targetEnabled = false;
        }

        const endpoint =
          targetEnabled === true
            ? "/api/v1/cues/enable"
            : targetEnabled === false
              ? "/api/v1/cues/disable"
              : "/api/v1/cues/toggle";

        const res = await this.postJson(`${baseUrl}${endpoint}`, {});
        return { ok: res.ok, action: actionId, target: "rundown:cues", result: res.data, error: res.error };
      }

      if (this.rundownStore) {
        if (op === "next") {
          const res = await this.rundownStore.next(String(params.actor ?? "action"));
          return { ok: res.advanced, action: actionId, target: "rundown:next", result: res.rundown };
        }
        if (op === "prev" || op === "previous") {
          const res = this.rundownStore.previous(String(params.actor ?? "action"));
          return { ok: res.moved, action: actionId, target: "rundown:previous", result: res.rundown };
        }
        if (op === "goto") {
          const id = String(params.id ?? "");
          const res = this.rundownStore.goto(id, String(params.actor ?? "action"));
          return { ok: res.moved, action: actionId, target: `rundown:goto:${id}`, result: res.rundown };
        }
        if (op === "skip") {
          const id = params.id ? String(params.id) : undefined;
          const res = this.rundownStore.skip(id, String(params.actor ?? "action"));
          return { ok: res.skipped, action: actionId, target: "rundown:skip", result: res.rundown };
        }
        if (op === "fire") {
          let target: any = undefined;
          if (typeof params.line === "number") {
            target = params.line;
          } else if (typeof params.index === "number") {
            target = { index: params.index };
          } else if (params.id !== undefined && params.id !== null) {
            target = String(params.id);
          } else if (params.target !== undefined && params.target !== null) {
            target = params.target;
          }
          const res = await this.rundownStore.fire(target, String(params.actor ?? "action"));
          const targetStr = typeof target === "object" ? JSON.stringify(target) : String(target ?? "current");
          return { ok: res.ok, action: actionId, target: `rundown:fire:${targetStr}`, result: res.executed };
        }
        if (op === "reset") {
          const res = this.rundownStore.reset(String(params.actor ?? "action"));
          return { ok: true, action: actionId, target: "rundown:reset", result: res };
        }
      }
    }

    // 8. Graphics Domain (forward to PiGraphics)
    if (domain === "graphics") {
      const baseUrl = this.config.pigraphicsApiUrl ?? "http://127.0.0.1:3107";
      if (op === "show") {
        const templateId = String(params.templateId ?? "lower-third-speaker");
        const res = await this.postJson(`${baseUrl}/api/v1/graphics/active/show`, {
          templateId,
          data: params.data ?? {},
          durationMs: params.durationMs
        });
        return { ok: res.ok, action: actionId, target: "graphics:show", result: res.data, error: res.error };
      }
      if (op === "hide") {
        const id = encodeURIComponent(String(params.id ?? ""));
        const res = await this.postJson(`${baseUrl}/api/v1/graphics/active/hide/${id}`, {});
        return { ok: res.ok, action: actionId, target: "graphics:hide", result: res.data, error: res.error };
      }
      if (op === "clear") {
        const res = await this.postJson(`${baseUrl}/api/v1/graphics/active/clear`, {});
        return { ok: res.ok, action: actionId, target: "graphics:clear", result: res.data, error: res.error };
      }
    }

    return { ok: false, action: actionId, error: `Unrecognized action '${actionId}'` };
  }

  private parseStringAction(str: string): ActionExecutionRequest {
    const parts = str.trim().split(":");
    const domain = parts[0]?.toLowerCase() ?? "";

    if (domain === "switch" || domain === "atem" || domain === "piswitch") {
      if (parts[1] === "cut") {
        const input = parts[2] ? (isNaN(Number(parts[2])) ? parts[2] : parseInt(parts[2], 10)) : undefined;
        return { action: `${domain}:cut`, params: input !== undefined ? { input } : {} };
      }
      if (parts[1] === "preview") {
        const input = parts[2] ? (isNaN(Number(parts[2])) ? parts[2] : parseInt(parts[2], 10)) : 1;
        return { action: `${domain}:preview`, params: { input } };
      }
      if (parts[1] === "program") {
        const input = parts[2] ? (isNaN(Number(parts[2])) ? parts[2] : parseInt(parts[2], 10)) : 1;
        return { action: `${domain}:program`, params: { input } };
      }
      if (parts[1] === "auto") return { action: `${domain}:auto` };
      if (parts[1] === "ftb") return { action: `${domain}:ftb` };
      if (parts[1] === "dsk") {
        const dskIndex = parts[2] ? parseInt(parts[2], 10) : 0;
        const state = parts[3] ?? "toggle";
        return { action: `${domain}:dsk`, params: { dskIndex, state } };
      }
    }

    if (domain === "cut") {
      const input = parts[1] ? (isNaN(Number(parts[1])) ? parts[1] : parseInt(parts[1], 10)) : undefined;
      return { action: "switch:cut", params: input !== undefined ? { input } : {} };
    }

    if (domain === "preview") {
      const input = parts[1] ? (isNaN(Number(parts[1])) ? parts[1] : parseInt(parts[1], 10)) : 1;
      return { action: "switch:preview", params: { input } };
    }

    if (domain === "cam" || domain === "camera") {
      // E.g. cam:1:preset:1 or cam:cam1:preset:1
      if (parts[2] === "preset") {
        return { action: "cam:preset", params: { id: parts[1], preset: parts[3] } };
      }
      if (parts[2] === "move") {
        return { action: "cam:move", params: { id: parts[1], direction: parts[3] } };
      }
    }

    if (domain === "tally") {
      // E.g. tally:cue:1:pan-left
      if (parts[1] === "cue") {
        return { action: "tally:cue", params: { unit: parts[2], cue: parts[3] } };
      }
    }

    if (domain === "pgm" || domain === "pipgm") {
      // E.g. pgm:hymn:332
      if (parts[1] === "hymn") {
        return { action: "pipgm:hymn", params: { hymn: parts[2] } };
      }
      if (parts[1] === "slide") {
        return { action: "pipgm:slide", params: { slide: parts[2] } };
      }
    }

    if (domain === "rundown") {
      // E.g. rundown:cues:toggle or rundown:cues:off or rundown:cues:on
      if (parts[1] === "cues" || parts[1] === "cue") {
        const state = parts[2] ?? "toggle";
        return { action: "rundown:cues", params: { state } };
      }
      if (parts[1] === "next") return { action: "rundown:next" };
      if (parts[1] === "prev" || parts[1] === "previous") return { action: "rundown:prev" };
      if (parts[1] === "reset") return { action: "rundown:reset" };
      if (parts[1] === "fire") {
        const arg = parts[2];
        if (arg !== undefined && /^\d+$/.test(arg)) {
          return { action: "rundown:fire", params: { line: parseInt(arg, 10) } };
        }
        return { action: "rundown:fire", params: arg ? { id: arg } : {} };
      }
      if (parts[1] === "goto") return { action: "rundown:goto", params: { id: parts[2] } };
      if (parts[1] === "skip") return { action: "rundown:skip", params: { id: parts[2] } };
    }

    if (domain === "graphics") {
      if (parts[1] === "clear") return { action: "graphics:clear", params: {} };
      if (parts[1] === "show") return { action: "graphics:show", params: { templateId: parts[2] } };
      if (parts[1] === "hide") return { action: "graphics:hide", params: { id: parts[2] } };
    }

    return { action: str, params: {} };
  }

  private async postJson(url: string, body: unknown): Promise<{ ok: boolean; data?: unknown; error?: string | undefined }> {
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        data = undefined;
      }
      return { ok: res.ok, data, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
