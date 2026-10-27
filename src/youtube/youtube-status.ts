/**
 * YouTube live status, written by pitube (the only YouTube connection) and read by
 * everything else, e.g. pilight. The gateway never talks to YouTube itself.
 *
 * The writer says how long its reading is good for (ttlMs). Once the gateway has
 * not heard from pitube for that long, the state reads as "unknown".
 */

export type YoutubeLiveState = "live" | "offline" | "unknown";

export const MIN_TTL_MS = 1000;
export const MAX_TTL_MS = 3_600_000;

export interface YoutubeStatusInput {
  state: YoutubeLiveState;
  detail?: string;
  /** Epoch ms on the sender's clock. */
  checkedAt: number;
  ttlMs: number;
}

export interface YoutubeStatusRecord extends YoutubeStatusInput {
  /** Epoch ms on the gateway's clock. */
  receivedAt: number;
}

export type YoutubeStatusParse =
  | { ok: true; value: YoutubeStatusInput }
  | { ok: false; message: string };

export function parseYoutubeStatus(body: unknown): YoutubeStatusParse {
  if (typeof body !== "object" || body === null) return { ok: false, message: "Body must be an object" };
  const { state, detail, checkedAt, ttlMs } = body as Record<string, unknown>;
  if (state !== "live" && state !== "offline" && state !== "unknown") {
    return { ok: false, message: 'state must be "live", "offline" or "unknown"' };
  }
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt) || checkedAt < 0) {
    return { ok: false, message: "checkedAt must be epoch milliseconds" };
  }
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
    return { ok: false, message: `ttlMs must be an integer between ${MIN_TTL_MS} and ${MAX_TTL_MS}` };
  }
  if (detail !== undefined && (typeof detail !== "string" || detail.length > 500)) {
    return { ok: false, message: "detail must be a string of at most 500 characters" };
  }
  return { ok: true, value: { state, checkedAt, ttlMs, ...(detail !== undefined && { detail }) } };
}

export interface YoutubeStatusStoreOptions {
  now?: () => number;
  onChange?: (record: YoutubeStatusRecord) => void;
}

export class YoutubeStatusStore {
  private record: YoutubeStatusRecord | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: YoutubeStatusStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The stored record, or "unknown" when none arrived or the last one has expired. */
  get(): YoutubeStatusRecord {
    if (!this.record) return { state: "unknown", checkedAt: 0, ttlMs: 0, receivedAt: 0 };
    if (this.record.state !== "unknown" && this.now() >= this.record.receivedAt + this.record.ttlMs) {
      return { ...this.record, state: "unknown", detail: "expired" };
    }
    return this.record;
  }

  set(input: YoutubeStatusInput): YoutubeStatusRecord {
    const before = this.get();
    this.record = { ...input, receivedAt: this.now() };
    this.arm();
    const after = this.get();
    if (before.state !== after.state || before.detail !== after.detail || before.checkedAt !== after.checkedAt) {
      this.options.onChange?.(after);
    }
    return this.record;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Publish the move to "unknown" when the reading runs out. */
  private arm(): void {
    this.stop();
    if (!this.record) return;
    const left = this.record.receivedAt + this.record.ttlMs - this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.options.onChange?.(this.get());
    }, Math.max(left, 0) + 5);
    this.timer.unref?.();
  }
}
