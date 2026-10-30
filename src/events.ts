import { EventEmitter } from "node:events";
import type { PiVoiceTelemetry } from "./pivoice/telemetry.js";
import type { PiSoundTelemetry } from "./pisound/telemetry.js";
import type { TranscriptEvent } from "./transcripts/transcript-hub.js";
import type { EcosystemStatus } from "./ecosystem/ecosystem-tracker.js";
import type { FreedTelemetry } from "./camera/freed-receiver.js";
import type { RundownStatusSnapshot } from "./rundown/rundown-store.js";

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

export interface SpatialScenePayload {
  updatedAt: string;
  activeZones: string[];
  subjects: Array<{
    trackId: number;
    sourceCameraId: string;
    position: { x: number; y: number; z: number };
    headHeight?: number | undefined;
    zoneId: string | null;
    zoneName: string | null;
    confidence: number;
    label: string;
    lastSeenAt: string;
  }>;
  cameras: Record<string, unknown>;
}

export interface SpatialZoneEventPayload {
  event: "entered" | "left";
  trackId: number;
  zoneId: string;
  zoneName: string;
  sourceCameraId: string;
  position?: { x: number; y: number; z: number } | undefined;
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
  | { type: "rundown"; data: RundownStatusSnapshot }
  | { type: "spatial"; data: SpatialScenePayload }
  | { type: "spatial-zone"; data: SpatialZoneEventPayload }
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
