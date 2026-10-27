/**
 * Matrox Monarch HDX encoder. Wraps @jsilvanus/matrox-monarch-control.
 *
 * The device answers RETRY when commands overlap, so every call (including the
 * status poll) goes through one queue, and a busy answer is retried a few times.
 * Status is polled and a change is published as an "encoder" event.
 */

import {
  MonarchBusyError,
  MonarchCommandError,
  MonarchConnectionError,
  MonarchHDX,
  type HDXStatus,
  type InputStatus
} from "@jsilvanus/matrox-monarch-control";

export type EncoderTarget = 1 | 2 | "both";

/** The part of MonarchHDX used here, so tests can pass a fake. */
export interface MonarchDevice {
  getStatus(): Promise<HDXStatus>;
  startEncoder(encoder: 1 | 2): Promise<unknown>;
  stopEncoder(encoder: 1 | 2): Promise<unknown>;
  startBothEncoders(): Promise<unknown>;
  stopBothEncoders(): Promise<unknown>;
  getInputStatus(): Promise<InputStatus>;
  getVideoInput(): Promise<string>;
  setVideoInput(input: "SDI" | "HDMI"): Promise<unknown>;
  getAudioInput(): Promise<string>;
  setAudioInput(input: "ANALOG" | "DIGITAL"): Promise<unknown>;
  getStreamingVideoDataRate(): Promise<number>;
  setStreamingVideoDataRate(kbps: number): Promise<unknown>;
  getRecordFileName(): Promise<string>;
  setRecordFileName(name: string): Promise<unknown>;
  getEncoderRTMP(encoder: 1 | 2): Promise<{ url: string; streamName: string; username?: string | undefined }>;
  setEncoderRTMP(encoder: 1 | 2, config: { url: string; streamName: string }): Promise<unknown>;
}

export interface EncoderState {
  configured: boolean;
  connected: boolean;
  name: string;
  encoder1: { mode: string; state: string };
  encoder2: { mode: string; state: string };
  error?: string;
}

export interface EncoderSettings {
  videoInput: string;
  audioInput: string;
  bitrateKbps: number;
  recordFileName: string;
  /** Stream key and password are never returned. */
  rtmp: Record<"encoder1" | "encoder2", { url: string; username?: string | undefined }>;
}

export class EncoderError extends Error {
  constructor(
    readonly code: "ENCODER_NOT_CONFIGURED" | "ENCODER_UNREACHABLE" | "ENCODER_BUSY" | "ENCODER_REFUSED",
    message: string
  ) {
    super(message);
  }
}

export interface EncoderServiceOptions {
  host?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  https?: boolean | undefined;
  pollMs?: number;
  busyRetries?: number;
  busyDelayMs?: number;
  /** Test hook. */
  device?: MonarchDevice;
  onChange?: (state: EncoderState) => void;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

const EMPTY: EncoderState["encoder1"] = { mode: "NONE", state: "DISABLED" };

export class EncoderService {
  private readonly device: MonarchDevice | null;
  private readonly options: EncoderServiceOptions;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private state: EncoderState;

  constructor(options: EncoderServiceOptions) {
    this.options = options;
    this.device =
      options.device ??
      (options.host
        ? (new MonarchHDX({
            host: options.host,
            ...(options.username && { username: options.username }),
            ...(options.password && { password: options.password }),
            protocol: options.https ? "https" : "http",
            timeout: 5000
          }) as unknown as MonarchDevice)
        : null);
    this.state = {
      configured: this.device !== null,
      connected: false,
      name: "",
      encoder1: { ...EMPTY },
      encoder2: { ...EMPTY }
    };
  }

  getState(): EncoderState {
    return this.state;
  }

  start(): void {
    if (!this.device || this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Refresh the status now (also what the poll runs). */
  async refresh(): Promise<EncoderState> {
    const device = this.need();
    try {
      const status = await this.run(() => device.getStatus());
      this.update({ configured: true, connected: true, name: status.name, encoder1: status.encoder1, encoder2: status.encoder2 });
    } catch (error) {
      this.update({ ...this.state, connected: false, error: describe(error) });
      throw this.wrap(error);
    }
    return this.state;
  }

  async startEncoder(target: EncoderTarget): Promise<EncoderState> {
    const device = this.need();
    await this.command(() =>
      target === "both" ? device.startBothEncoders() : device.startEncoder(target)
    );
    return this.refresh();
  }

  async stopEncoder(target: EncoderTarget): Promise<EncoderState> {
    const device = this.need();
    await this.command(() =>
      target === "both" ? device.stopBothEncoders() : device.stopEncoder(target)
    );
    return this.refresh();
  }

  async getInputStatus(): Promise<InputStatus> {
    const device = this.need();
    return this.command(() => device.getInputStatus());
  }

  async getSettings(): Promise<EncoderSettings> {
    const device = this.need();
    return this.command(async () => {
      const [videoInput, audioInput, bitrateKbps, recordFileName, rtmp1, rtmp2] = [
        await device.getVideoInput(),
        await device.getAudioInput(),
        await device.getStreamingVideoDataRate(),
        await device.getRecordFileName(),
        await device.getEncoderRTMP(1),
        await device.getEncoderRTMP(2)
      ];
      return {
        videoInput,
        audioInput,
        bitrateKbps,
        recordFileName,
        rtmp: {
          encoder1: { url: rtmp1.url, username: rtmp1.username },
          encoder2: { url: rtmp2.url, username: rtmp2.username }
        }
      };
    });
  }

  async setSettings(change: {
    videoInput?: "SDI" | "HDMI";
    audioInput?: "ANALOG" | "DIGITAL";
    bitrateKbps?: number;
    recordFileName?: string;
  }): Promise<EncoderSettings> {
    const device = this.need();
    await this.command(async () => {
      if (change.videoInput) await device.setVideoInput(change.videoInput);
      if (change.audioInput) await device.setAudioInput(change.audioInput);
      if (change.bitrateKbps !== undefined) await device.setStreamingVideoDataRate(change.bitrateKbps);
      if (change.recordFileName !== undefined) await device.setRecordFileName(change.recordFileName);
    });
    return this.getSettings();
  }

  async setRtmp(encoder: 1 | 2, config: { url: string; streamName: string }): Promise<void> {
    const device = this.need();
    await this.command(() => device.setEncoderRTMP(encoder, config));
  }

  private need(): MonarchDevice {
    if (!this.device) throw new EncoderError("ENCODER_NOT_CONFIGURED", "No Monarch encoder is configured");
    return this.device;
  }

  /** One call at a time; a busy answer is retried. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const tries = (this.options.busyRetries ?? 3) + 1;
      for (let attempt = 1; ; attempt++) {
        try {
          return await fn();
        } catch (error) {
          if (!(error instanceof MonarchBusyError) || attempt >= tries) throw error;
          await new Promise((resolve) => setTimeout(resolve, this.options.busyDelayMs ?? 300));
        }
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async command<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.run(fn);
    } catch (error) {
      throw this.wrap(error);
    }
  }

  private wrap(error: unknown): Error {
    if (error instanceof EncoderError) return error;
    if (error instanceof MonarchBusyError) return new EncoderError("ENCODER_BUSY", "Encoder is busy, try again");
    if (error instanceof MonarchCommandError) {
      return new EncoderError("ENCODER_REFUSED", "Encoder refused the command (settings cannot change while it is running)");
    }
    if (error instanceof MonarchConnectionError) return new EncoderError("ENCODER_UNREACHABLE", "Encoder is not reachable");
    return error instanceof Error ? error : new Error(String(error));
  }

  private update(next: EncoderState): void {
    const clean: EncoderState = { ...next };
    if (clean.connected) delete clean.error;
    const changed = JSON.stringify(clean) !== JSON.stringify(this.state);
    this.state = clean;
    if (changed) this.options.onChange?.(clean);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      await this.refresh();
    } catch (error) {
      this.options.logger?.warn({ err: error }, "Encoder status poll failed");
    }
    if (this.running) this.timer = setTimeout(() => void this.poll(), this.options.pollMs ?? 3000);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
