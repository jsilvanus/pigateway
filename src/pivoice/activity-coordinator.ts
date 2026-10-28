import type { FastifyBaseLogger } from "fastify";
import type { PiVoiceTelemetry } from "./telemetry.js";

export interface PiVoiceActivityOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  idleCloseSeconds: number;
  startWhen?: "speech" | "speech_or_music";
  fetchFn?: typeof fetch;
  logger?: FastifyBaseLogger;
  onChange?: (state: PiVoiceActivityState) => void;
}

export interface PiVoiceActivityState {
  configured: boolean;
  session: "closed" | "starting" | "open" | "stopping" | "error";
  trigger: "speech" | "music" | null;
  idleCloseSeconds: number;
  lastActivityAt: string | null;
  lastError: string | null;
}

/** PiGateway owns activity-triggered session start/stop and the idle-close timer.
 * Audio never passes through this coordinator; PiVoice submits pre-roll to Auditor.
 */
export class PiVoiceActivityCoordinator {
  readonly #options: PiVoiceActivityOptions;
  readonly #fetch: typeof fetch;
  #state: PiVoiceActivityState;
  #idleTimer: NodeJS.Timeout | null = null;
  #active = false;
  #operation: Promise<unknown> | null = null;
  #lastStartAttemptMs = 0;
  #latestTrigger: "speech" | "music" = "speech";

  constructor(options: PiVoiceActivityOptions) {
    this.#options = options;
    this.#fetch = options.fetchFn ?? fetch;
    this.#state = {
      configured: Boolean(options.baseUrl),
      session: "closed",
      trigger: null,
      idleCloseSeconds: options.idleCloseSeconds,
      lastActivityAt: null,
      lastError: null
    };
  }

  getState(): PiVoiceActivityState {
    return { ...this.#state };
  }

  setIdleCloseSeconds(seconds: number): PiVoiceActivityState {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
      throw new RangeError("idleCloseSeconds must be an integer from 0 to 3600");
    }
    this.#state.idleCloseSeconds = seconds;
    this.#clearTimer();
    this.#publish();
    if (!this.#active) this.#scheduleClose();
    return this.getState();
  }

  observe(telemetry: PiVoiceTelemetry): void {
    if (!this.#options.baseUrl) return;
    const wasActive = this.#active;
    const activity = telemetry.connected && !telemetry.stale && telemetry.capture.state === "running"
      ? telemetry.classification
      : "silence";
    const matchesTrigger = activity === "speech" || (activity === "music" && (this.#options.startWhen ?? "speech_or_music") === "speech_or_music");
    if (matchesTrigger) {
      this.#latestTrigger = activity;
      this.#active = true;
      this.#state.lastActivityAt = new Date().toISOString();
      this.#state.lastError = null;
      this.#clearTimer();
      if (this.#state.session === "closed" || this.#state.session === "error") {
        void this.#start(activity);
      } else if (this.#state.session === "open" && this.#state.idleCloseSeconds > 0) {
        this.#scheduleClose();
      }
      return;
    }
    this.#active = false;
    if (wasActive && this.#state.session === "open" && this.#state.idleCloseSeconds > 0) this.#scheduleClose();
    if (!telemetry.connected || telemetry.capture.state === "stopped" || telemetry.capture.state === "error") {
      if (this.#state.session === "open") void this.#stop("capture-stopped");
    }
  }

  async close(): Promise<void> {
    this.#clearTimer();
    this.#active = false;
    if (this.#operation) await this.#operation.catch(() => undefined);
    if (this.#state.session === "open") await this.#stop("gateway-shutdown");
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...(this.#options.token ? { authorization: `Bearer ${this.#options.token}` } : {}) };
  }

  async #request(path: string, body: Record<string, unknown>): Promise<void> {
    if (!this.#options.baseUrl) throw new Error("PiVoice API URL is not configured");
    const response = await this.#fetch(`${this.#options.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`PiVoice control failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
  }

  async #start(trigger: "speech" | "music"): Promise<void> {
    if (this.#operation || this.#state.session === "open") return;
    const now = Date.now();
    if (now - this.#lastStartAttemptMs < 5000) return;
    this.#lastStartAttemptMs = now;
    this.#state.session = "starting";
    this.#state.trigger = trigger;
    this.#publish();
    this.#operation = this.#request("/api/v1/activity/session/start", { trigger });
    try {
      await this.#operation;
      this.#state.session = "open";
      this.#state.lastError = null;
      this.#publish();
      if (!this.#active) this.#scheduleClose();
    } catch (error) {
      this.#state.session = "error";
      this.#state.lastError = error instanceof Error ? error.message : String(error);
      this.#options.logger?.warn({ err: error }, "Unable to start PiVoice activity session");
      this.#publish();
    } finally {
      this.#operation = null;
      if (this.#state.session === "open" && !this.#active) this.#scheduleClose();
    }
  }

  async #stop(reason: string): Promise<void> {
    if (this.#operation || this.#state.session !== "open") return;
    this.#clearTimer();
    this.#state.session = "stopping";
    this.#publish();
    this.#operation = this.#request("/api/v1/activity/session/stop", { reason });
    try {
      await this.#operation;
      this.#state.session = "closed";
      this.#state.trigger = null;
      this.#state.lastError = null;
      this.#publish();
    } catch (error) {
      this.#state.session = "error";
      this.#state.lastError = error instanceof Error ? error.message : String(error);
      this.#options.logger?.warn({ err: error }, "Unable to stop PiVoice activity session");
      this.#publish();
    } finally {
      this.#operation = null;
      if (this.#state.session === "closed" && this.#active) void this.#start(this.#latestTrigger);
    }
  }

  #scheduleClose(): void {
    this.#clearTimer();
    const seconds = this.#state.idleCloseSeconds;
    if (seconds <= 0 || this.#active || this.#state.session !== "open") return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (!this.#active) void this.#stop("idle-timeout");
    }, seconds * 1000);
    this.#idleTimer.unref?.();
  }

  #clearTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #publish(): void {
    this.#options.onChange?.(this.getState());
  }
}
