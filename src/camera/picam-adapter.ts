import type { FastifyBaseLogger } from "fastify";
import type {
  CameraAdapter,
  CameraPosition,
  CameraPreset,
  CameraSnapshot,
  FocusMode,
  FreedState,
  FreedTarget,
  SmartFrameState
} from "./camera-adapter.js";
import type { PanTiltDirection, SmartFrameMode, ZoomAction } from "./visca-protocol.js";

export interface HttpPicamCameraConfig {
  id: string;
  label: string;
  baseUrl: string;
  fetchFn?: typeof fetch | undefined;
  logger?: FastifyBaseLogger | undefined;
}

export class HttpPicamCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly label: string;
  readonly model = "AVer PTZ330 (via PiCam)";
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger?: FastifyBaseLogger | undefined;

  private snapshot: CameraSnapshot;

  constructor(config: HttpPicamCameraConfig) {
    this.id = config.id;
    this.label = config.label;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.fetchFn = config.fetchFn ?? fetch;
    this.logger = config.logger;

    this.snapshot = {
      id: this.id,
      label: this.label,
      model: this.model,
      connection: "connected",
      streaming: false,
      streamUrl: null,
      smartFrame: "disabled",
      privacyBlur: false,
      focusMode: "auto",
      position: { pan: 0, tilt: 0, zoom: 0 },
      presets: [
        { id: 1, name: "Pulpit" },
        { id: 2, name: "Altar" },
        { id: 3, name: "Organ" },
        { id: 4, name: "Choir" },
        { id: 5, name: "Lectern" },
        { id: 6, name: "Wide Hall" }
      ]
    };

    // Asynchronously sync initial state if reachable
    void this.syncSnapshot();
  }

  private async request<T = any>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const options: RequestInit = {
      method,
      headers
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await this.fetchFn(url, options);
    if (!res.ok) {
      let message = `PiCam returned HTTP ${res.status}`;
      try {
        const errJson = (await res.json()) as any;
        if (errJson?.error?.message) {
          message = errJson.error.message;
        }
      } catch {
        // use default message
      }
      throw new Error(message);
    }
    return (await res.json()) as T;
  }

  async syncSnapshot(): Promise<CameraSnapshot> {
    try {
      const data = await this.request<any>(`/api/v1/cameras/${this.id}`);
      if (data && typeof data === "object") {
        this.snapshot = {
          ...this.snapshot,
          ...data,
          id: this.id,
          label: this.label,
          connection: "connected"
        };
      }
    } catch (err) {
      this.logger?.debug?.({ err, camera: this.id }, "Failed to sync snapshot from PiCam");
    }
    return this.snapshot;
  }

  getSnapshot(): CameraSnapshot {
    return { ...this.snapshot };
  }

  async move(direction: PanTiltDirection, panSpeed = 10, tiltSpeed = 10): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/move`, "POST", {
      direction,
      panSpeed,
      tiltSpeed
    });
  }

  async zoom(action: ZoomAction, speed = 4): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/zoom`, "POST", {
      action,
      speed
    });
  }

  async recallPreset(presetId: number): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/presets/${presetId}/recall`, "POST");
  }

  async savePreset(presetId: number, name?: string): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/presets/${presetId}/save`, "POST", {
      name
    });
    const existing = this.snapshot.presets.find((p) => p.id === presetId);
    if (existing) {
      if (name) existing.name = name;
    } else {
      this.snapshot.presets.push({ id: presetId, ...(name ? { name } : {}) });
      this.snapshot.presets.sort((a, b) => a.id - b.id);
    }
  }

  async savePresetThumbnail(presetId: number, thumbnail: string): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/presets/${presetId}/thumbnail`, "POST", {
      thumbnail
    });
    const existing = this.snapshot.presets.find((p) => p.id === presetId);
    if (existing) {
      existing.thumbnail = thumbnail;
    } else {
      this.snapshot.presets.push({ id: presetId, thumbnail });
      this.snapshot.presets.sort((a, b) => a.id - b.id);
    }
  }

  async resetPreset(presetId: number): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/presets/${presetId}/reset`, "POST");
    this.snapshot.presets = this.snapshot.presets.filter((p) => p.id !== presetId);
  }

  async setSmartFrame(mode: SmartFrameMode): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/smartframe`, "POST", {
      mode
    });
    this.snapshot.smartFrame = mode === "enable" ? "enabled" : mode === "disable" ? "disabled" : "triggered";
  }

  async setPower(on: boolean): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/power/${on ? "on" : "off"}`, "POST");
  }

  async getFreed(): Promise<FreedState> {
    return this.request<FreedState>(`/api/v1/cameras/${this.id}/freed`, "GET");
  }

  async setFreed(enabled: boolean, target?: FreedTarget): Promise<FreedState> {
    return this.request<FreedState>(`/api/v1/cameras/${this.id}/freed`, "POST", {
      enabled,
      ...(target ? { camId: target.camId, addr: target.addr, port: target.port } : {})
    });
  }

  async setPrivacyBlur(enabled: boolean): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/defocus`, "POST", {
      action: enabled ? "blur" : "restore"
    });
    this.snapshot.privacyBlur = enabled;
  }

  async setFocusMode(mode: FocusMode): Promise<void> {
    this.snapshot.focusMode = mode;
  }

  async startStream(): Promise<string | null> {
    const res = await this.request<{ streamUrl?: string }>(`/api/v1/cameras/${this.id}/stream`, "POST", {
      action: "start"
    });
    this.snapshot.streaming = true;
    this.snapshot.streamUrl = res.streamUrl ?? null;
    return this.snapshot.streamUrl;
  }

  async stopStream(): Promise<void> {
    await this.request(`/api/v1/cameras/${this.id}/stream`, "POST", {
      action: "stop"
    });
    this.snapshot.streaming = false;
    this.snapshot.streamUrl = null;
  }

  async close(): Promise<void> {
    // Stateless HTTP adapter has no persistent sockets to close
  }
}
