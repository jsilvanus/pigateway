import { randomBytes } from "node:crypto";

/** A final transcript as served on the gateway bus. See pitube/CONTRACT.md. */
export interface TranscriptEvent {
  epoch: string;
  seq: number;
  session: string;
  language: string;
  text: string;
  /** Epoch milliseconds of the spoken audio (capture wall clock), not of delivery. */
  startedAt: number;
  endedAt: number;
  source: "auditor";
}

/** The shape liturgos-auditor uses for a transcript (SSE `transcript` data, push `events[]`). */
export interface AuditorTranscript {
  sequence?: unknown;
  text?: unknown;
  language?: unknown;
  wall_start?: unknown;
  wall_end?: unknown;
}

export interface IngestResult {
  accepted: TranscriptEvent[];
  duplicates: number;
  rejected: Array<{ index: number; reason: string }>;
}

export const MAX_TRANSCRIPT_TEXT = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const LANG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;

export function transcriptId(event: Pick<TranscriptEvent, "epoch" | "seq">): string {
  return `${event.epoch}:${event.seq}`;
}

/** Parse `<epoch>:<seq>`; null when malformed. */
export function parseTranscriptId(value: string | undefined | null): { epoch: string; seq: number } | null {
  if (!value) return null;
  const match = /^([A-Za-z0-9_-]{1,32}):(\d{1,15})$/.exec(value.trim());
  return match ? { epoch: match[1] as string, seq: Number(match[2]) } : null;
}

export interface TranscriptHubOptions {
  /** How many recent transcripts are kept for replay. */
  capacity?: number;
  now?: () => number;
  epoch?: string;
  onTranscript?: (event: TranscriptEvent) => void;
}

/**
 * Accepts transcripts from the STT engine (pushed over HTTP or pulled from its SSE), normalises
 * them, drops duplicates, numbers them and keeps a bounded window for replay.
 */
export class TranscriptHub {
  readonly epoch: string;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #onTranscript: ((event: TranscriptEvent) => void) | undefined;
  readonly #ring: TranscriptEvent[] = [];
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  #seq = 0;
  #stats = { accepted: 0, duplicates: 0, rejected: 0, lastAcceptedAt: null as string | null };

  constructor(options: TranscriptHubOptions = {}) {
    this.#capacity = options.capacity ?? 500;
    this.#now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomBytes(4).toString("hex");
    this.#onTranscript = options.onTranscript;
  }

  status() {
    return { epoch: this.epoch, seq: this.#seq, buffered: this.#ring.length, capacity: this.#capacity, ...this.#stats };
  }

  /** Normalise and store a batch from one STT session. Invalid entries are reported, never thrown. */
  ingest(session: string, events: unknown[]): IngestResult {
    const result: IngestResult = { accepted: [], duplicates: 0, rejected: [] };
    const nowMs = this.#now();
    events.forEach((raw, index) => {
      const checked = this.#normalise(raw as AuditorTranscript, nowMs);
      if (typeof checked === "string") {
        result.rejected.push({ index, reason: checked });
        this.#stats.rejected++;
        return;
      }
      const sequence = Number((raw as AuditorTranscript).sequence);
      const dedupeKey = Number.isFinite(sequence) && sequence > 0 ? `${session}#${sequence}` : null;
      if (dedupeKey && this.#seen.has(dedupeKey)) {
        result.duplicates++;
        this.#stats.duplicates++;
        return;
      }
      if (dedupeKey) this.#remember(dedupeKey);
      const event: TranscriptEvent = { epoch: this.epoch, seq: ++this.#seq, session, ...checked, source: "auditor" };
      this.#ring.push(event);
      if (this.#ring.length > this.#capacity) this.#ring.splice(0, this.#ring.length - this.#capacity);
      this.#stats.accepted++;
      this.#stats.lastAcceptedAt = new Date(nowMs).toISOString();
      result.accepted.push(event);
      this.#onTranscript?.(event);
    });
    return result;
  }

  /**
   * Transcripts newer than `after`. A missing or foreign-epoch id replays nothing (a fresh consumer
   * gets live events only; a consumer of a previous gateway run must not trust old numbers).
   */
  since(after: string | undefined | null, limit = 200): TranscriptEvent[] {
    const id = parseTranscriptId(after);
    if (!id || id.epoch !== this.epoch) return [];
    return this.#ring.filter((event) => event.seq > id.seq).slice(0, Math.max(1, limit));
  }

  #remember(key: string): void {
    this.#seen.add(key);
    this.#seenOrder.push(key);
    if (this.#seenOrder.length > this.#capacity * 4) {
      const old = this.#seenOrder.splice(0, this.#seenOrder.length - this.#capacity * 4);
      for (const k of old) this.#seen.delete(k);
    }
  }

  #normalise(raw: AuditorTranscript, nowMs: number): Pick<TranscriptEvent, "language" | "text" | "startedAt" | "endedAt"> | string {
    if (!raw || typeof raw !== "object") return "transcript must be an object";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) return "text must not be empty";
    const startedAt = Date.parse(String(raw.wall_start ?? ""));
    const rawEnd = Date.parse(String(raw.wall_end ?? ""));
    if (!Number.isFinite(startedAt)) return "wall_start must be an ISO 8601 time";
    if (startedAt < nowMs - MAX_AGE_MS || startedAt > nowMs + MAX_FUTURE_MS) return "wall_start is outside the accepted window";
    const endedAt = Number.isFinite(rawEnd) ? Math.max(rawEnd, startedAt) : startedAt;
    const language = typeof raw.language === "string" && LANG.test(raw.language.trim().toLowerCase()) ? raw.language.trim().toLowerCase() : "und";
    return { language, text: text.slice(0, MAX_TRANSCRIPT_TEXT), startedAt: Math.round(startedAt), endedAt: Math.round(endedAt) };
  }
}
