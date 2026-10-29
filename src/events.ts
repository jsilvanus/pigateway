import { EventEmitter } from "node:events";
import type { PiVoiceTelemetry } from "./pivoice/telemetry.js";
import type { PiSoundTelemetry } from "./pisound/telemetry.js";
import type { TranscriptEvent } from "./transcripts/transcript-hub.js";
import type { EcosystemStatus } from "./ecosystem/ecosystem-tracker.js";
import type { FreedTelemetry } from "./camera/freed-receiver.js";

export interface CameraEventPayload {
  id: string;
  action: string;
  streaming?: boolean;
  presetId?: number;
  thumbnail?: string;
  smartFrame?: string;
  privacyBlur?: boolean;
  focusMode?: string;
  position?: { pan: number; tilt: number; zoom: number };
}

export interface MatrixEventPayload {
  locked: boolean;
  routes: Record<number, number | null>;
  lastChange?: { input: number; output: number };
}

export interface ActionEventPayload {
  actor: string;
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
  target?: string | undefined;
  error?: string | undefined;
  timestamp: string;
}

export type GatewayEvent =
  | { type: "camera"; data: CameraEventPayload }
  | { type: "freed"; data: FreedTelemetry }
  | { type: "atem"; data: unknown }
  | { type: "matrix"; data: MatrixEventPayload }
  | { type: "encoder"; data: unknown }
  | { type: "youtube"; data: unknown }
  | { type: "pivoice"; data: PiVoiceTelemetry }
  | { type: "pisound"; data: PiSoundTelemetry }
  | { type: "pivoice-activity"; data: unknown }
  | { type: "transcript"; data: TranscriptEvent }
  | { type: "ecosystem"; data: EcosystemStatus }
  | { type: "action"; data: ActionEventPayload }
  | { type: "ready"; data: { status: string; time: string } };

export class GatewayEventBroker {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: GatewayEvent): void {
    this.emitter.emit("event", event);
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  listenerCount(): number {
    return this.emitter.listenerCount("event");
  }
}
