import { EventEmitter } from "node:events";

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

export type GatewayEvent =
  | { type: "camera"; data: CameraEventPayload }
  | { type: "atem"; data: unknown }
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
