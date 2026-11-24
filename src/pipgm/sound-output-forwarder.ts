import type { FastifyBaseLogger } from "fastify";
import type { GatewayEventBroker } from "../events.js";
import type { PiMatrixClient } from "../matrix/client.js";
import type { PiProgramClient } from "./client.js";

export interface SoundOutputForwarderOptions {
  pimatrix: PiMatrixClient;
  piprogram: PiProgramClient;
  eventBroker: GatewayEventBroker;
  logger?: FastifyBaseLogger | undefined;
  /** Heartbeat so piprogram does not treat the report as stale (it forgets after 30 s). */
  intervalMs?: number;
  /** Wait after a matrix change so a burst of route changes becomes one report. */
  debounceMs?: number;
}

export interface SoundOutputForwardStatus {
  enabled: boolean;
  lastOutput: string | null | undefined;
  lastPushedAt: string | null;
  lastError: string | null;
}

/**
 * Tells piprogram which Pi HDMI output reaches the PA. pimatrix knows the Atlona wiring and answers
 * `GET /api/v1/sound-output`; this pushes that answer to piprogram when the matrix changes and on a heartbeat.
 * Off until enabled; it only reports, it plays nothing.
 */
export class SoundOutputForwarder {
  readonly #o: SoundOutputForwarderOptions;
  #enabled = false;
  #timer: NodeJS.Timeout | undefined;
  #debounce: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #running = false;
  #last: SoundOutputForwardStatus = { enabled: false, lastOutput: undefined, lastPushedAt: null, lastError: null };

  constructor(options: SoundOutputForwarderOptions) {
    this.#o = options;
  }

  status(): SoundOutputForwardStatus {
    return { ...this.#last, enabled: this.#enabled };
  }

  setEnabled(enabled: boolean): SoundOutputForwardStatus {
    if (enabled === this.#enabled) return this.status();
    this.#enabled = enabled;
    if (enabled) {
      this.#unsubscribe = this.#o.eventBroker.subscribe((event) => {
        if (event.type !== "matrix") return;
        clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => void this.pushOnce(), this.#o.debounceMs ?? 500);
      });
      this.#timer = setInterval(() => void this.pushOnce(), this.#o.intervalMs ?? 10_000);
      this.#timer.unref?.();
      void this.pushOnce();
    } else {
      this.stop();
    }
    return this.status();
  }

  stop(): void {
    this.#enabled = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    clearInterval(this.#timer);
    clearTimeout(this.#debounce);
    this.#timer = undefined;
    this.#debounce = undefined;
  }

  /** One lookup and one push. A failed lookup pushes nothing, so piprogram's report goes stale and it refuses to speak. */
  async pushOnce(): Promise<void> {
    if (!this.#enabled || this.#running) return;
    this.#running = true;
    try {
      const report = await this.#o.pimatrix.request<{ hdmi?: string | null }>("GET", "/api/v1/sound-output");
      const output = report.hdmi === "hdmi0" || report.hdmi === "hdmi1" ? report.hdmi : null;
      await this.#o.piprogram.request("PUT", "/api/v1/pipgm/audio/sound-output", { output, source: "pigateway" });
      this.#last = { enabled: this.#enabled, lastOutput: output, lastPushedAt: new Date().toISOString(), lastError: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#last = { ...this.#last, lastError: message };
      this.#o.logger?.warn({ err }, "sound output forwarding failed");
    } finally {
      this.#running = false;
    }
  }
}
