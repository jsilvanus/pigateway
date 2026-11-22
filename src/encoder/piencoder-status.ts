import type { EncoderState } from "./encoder-service.js";

export interface PiencoderStatusOptions {
  /** piencoder base URL (PIGATEWAY_PIENCODER_API_URL). */
  url: string;
  fetchFn?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Cached answer is reused for this long. */
  ttlMs?: number | undefined;
  now?: (() => number) | undefined;
}

const EMPTY: EncoderState["encoder1"] = { mode: "NONE", state: "DISABLED" };

function unit(value: unknown): EncoderState["encoder1"] {
  const v = value as { mode?: unknown; state?: unknown } | undefined;
  return typeof v?.mode === "string" && typeof v?.state === "string" ? { mode: v.mode, state: v.state } : { ...EMPTY };
}

/**
 * Reads the hardware encoder state from piencoder (which owns the Monarch connection), so the
 * gateway status does not depend on its own legacy PIGATEWAY_ENCODER_* settings.
 */
export class PiencoderStatus {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #state: EncoderState;
  #at = Number.NEGATIVE_INFINITY;

  constructor(options: PiencoderStatusOptions) {
    this.#url = options.url.replace(/\/+$/, "");
    this.#fetch = options.fetchFn ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 1500;
    this.#ttlMs = options.ttlMs ?? 2000;
    this.#now = options.now ?? Date.now;
    this.#state = this.#unreachable("not polled yet");
  }

  #unreachable(error: string): EncoderState {
    return { configured: true, connected: false, name: "", encoder1: { ...EMPTY }, encoder2: { ...EMPTY }, error };
  }

  /** Last known state without a request. */
  getState(): EncoderState {
    return this.#state;
  }

  async refresh(force = false): Promise<EncoderState> {
    if (!force && this.#now() - this.#at < this.#ttlMs) return this.#state;
    this.#at = this.#now();
    try {
      const res = await this.#fetch(`${this.#url}/api/v1/encoder`, { signal: AbortSignal.timeout(this.#timeoutMs) });
      if (!res.ok) throw new Error(`piencoder answered ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [];
      const primary = items.find((i) => i.id === 1) ?? items[0] ?? data;
      this.#state = {
        configured: primary.configured !== false,
        connected: primary.connected === true,
        name: typeof primary.name === "string" ? primary.name : "",
        encoder1: unit(primary.encoder1),
        encoder2: unit(primary.encoder2),
        ...(typeof primary.error === "string" ? { error: primary.error } : {})
      };
    } catch (err) {
      this.#state = this.#unreachable(`piencoder unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.#state;
  }
}
