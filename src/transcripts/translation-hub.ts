import { randomBytes } from "node:crypto";

/**
 * A caption translation as PiVoice emits it (pivoice docs/translations/plan.md §5.7) plus the
 * numbering the gateway adds. Served on the bus as `translation` events.
 */
export interface TranslationEvent {
  epoch: string;
  seq: number;
  /** Bus id of the transcript this translates, when it is still in the transcript ring. */
  sourceId: string | null;
  sourceKey: string;
  sourceSeq: number;
  session: string;
  /** Language of the original. */
  source: string;
  /** Language of `text`. */
  lang: string;
  text: string;
  startMs: number;
  endMs: number;
  origin: "memory" | "model";
  route?: "mt" | "llm" | "hosted";
  model?: string;
  latencyMs?: number;
}

export interface TranslationIngestResult {
  accepted: TranslationEvent[];
  duplicates: number;
  rejected: Array<{ index: number; reason: string }>;
}

export const MAX_TRANSLATION_TEXT = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const LANG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;
const ROUTES = new Set(["mt", "llm", "hosted"]);

/** Bus event id of a translation: `<epoch>:t<seq>`. */
export function translationId(event: Pick<TranslationEvent, "epoch" | "seq">): string {
  return `${event.epoch}:t${event.seq}`;
}

/** Parse `<epoch>:t<seq>`; null when malformed (including plain transcript ids). */
export function parseTranslationId(value: string | undefined | null): { epoch: string; seq: number } | null {
  if (!value) return null;
  const match = /^([A-Za-z0-9_-]{1,32}):t(\d{1,15})$/.exec(value.trim());
  return match ? { epoch: match[1] as string, seq: Number(match[2]) } : null;
}

export interface TranslationHubOptions {
  /** How many recent translations are kept for replay. */
  capacity?: number;
  now?: () => number;
  epoch?: string;
  /** Looks up the transcript bus id for (session, STT sequence), e.g. `TranscriptHub.resolveId`. */
  resolveSourceId?: (session: string, sequence: number) => string | null;
  onTranslation?: (event: TranslationEvent) => void;
}

/**
 * Accepts translations from PiVoice, validates them like transcripts, drops duplicates on
 * (sourceKey, lang), numbers them and keeps a bounded window for replay. It never translates.
 */
export class TranslationHub {
  readonly epoch: string;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #resolve: (session: string, sequence: number) => string | null;
  readonly #onTranslation: ((event: TranslationEvent) => void) | undefined;
  readonly #ring: TranslationEvent[] = [];
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  #seq = 0;
  #stats = { accepted: 0, duplicates: 0, rejected: 0, lastAcceptedAt: null as string | null };

  constructor(options: TranslationHubOptions = {}) {
    this.#capacity = options.capacity ?? 500;
    this.#now = options.now ?? Date.now;
    this.epoch = options.epoch ?? randomBytes(4).toString("hex");
    this.#resolve = options.resolveSourceId ?? (() => null);
    this.#onTranslation = options.onTranslation;
  }

  status() {
    return { epoch: this.epoch, seq: this.#seq, buffered: this.#ring.length, capacity: this.#capacity, ...this.#stats };
  }

  /** Normalise and store a batch. Invalid entries are reported, never thrown. */
  ingest(events: unknown[]): TranslationIngestResult {
    const result: TranslationIngestResult = { accepted: [], duplicates: 0, rejected: [] };
    const nowMs = this.#now();
    events.forEach((raw, index) => {
      const checked = this.#normalise(raw, nowMs);
      if (typeof checked === "string") {
        result.rejected.push({ index, reason: checked });
        this.#stats.rejected++;
        return;
      }
      const dedupeKey = `${checked.sourceKey}\u0000${checked.lang}`;
      if (this.#seen.has(dedupeKey)) {
        result.duplicates++;
        this.#stats.duplicates++;
        return;
      }
      this.#remember(dedupeKey);
      const event: TranslationEvent = {
        epoch: this.epoch,
        seq: ++this.#seq,
        sourceId: this.#resolve(checked.session, checked.sourceSeq),
        ...checked
      };
      this.#ring.push(event);
      if (this.#ring.length > this.#capacity) this.#ring.splice(0, this.#ring.length - this.#capacity);
      this.#stats.accepted++;
      this.#stats.lastAcceptedAt = new Date(nowMs).toISOString();
      result.accepted.push(event);
      this.#onTranslation?.(event);
    });
    return result;
  }

  /** Translations newer than `after` (`<epoch>:t<seq>`). Missing or foreign-epoch ids replay nothing. */
  since(after: string | undefined | null, limit = 200): TranslationEvent[] {
    const id = parseTranslationId(after);
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

  #normalise(raw: unknown, nowMs: number): Omit<TranslationEvent, "epoch" | "seq" | "sourceId"> | string {
    if (!raw || typeof raw !== "object") return "translation must be an object";
    const r = raw as Record<string, unknown>;
    const sourceKey = typeof r.sourceKey === "string" ? r.sourceKey.trim() : "";
    if (!sourceKey || sourceKey.length > 200) return "sourceKey must be a non-empty string of at most 200 characters";
    const session = typeof r.session === "string" ? r.session.trim() : "";
    if (!session || session.length > 100) return "session must be a non-empty string of at most 100 characters";
    const sourceSeq = Number(r.sourceSeq);
    if (!Number.isSafeInteger(sourceSeq) || sourceSeq < 0) return "sourceSeq must be a non-negative integer";
    const source = typeof r.source === "string" ? r.source.trim().toLowerCase() : "";
    const lang = typeof r.lang === "string" ? r.lang.trim().toLowerCase() : "";
    if (!LANG.test(source)) return "source must be a language code";
    if (!LANG.test(lang)) return "lang must be a language code";
    if (source === lang) return "lang must differ from source";
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!text) return "text must not be empty";
    const startMs = Number(r.startMs);
    const endMs = Number(r.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "startMs and endMs must be epoch milliseconds";
    if (startMs < nowMs - MAX_AGE_MS || startMs > nowMs + MAX_FUTURE_MS) return "startMs is outside the accepted window";
    if (r.origin !== "memory" && r.origin !== "model") return "origin must be memory or model";
    const out: Omit<TranslationEvent, "epoch" | "seq" | "sourceId"> = {
      sourceKey,
      sourceSeq,
      session,
      source,
      lang,
      text: text.slice(0, MAX_TRANSLATION_TEXT),
      startMs: Math.round(startMs),
      endMs: Math.round(Math.max(endMs, startMs)),
      origin: r.origin
    };
    if (typeof r.route === "string" && ROUTES.has(r.route) && r.origin === "model") out.route = r.route as "mt" | "llm" | "hosted";
    if (typeof r.model === "string" && r.model.trim()) out.model = r.model.trim().slice(0, 100);
    const latency = Number(r.latencyMs);
    if (r.latencyMs !== undefined && Number.isFinite(latency) && latency >= 0) out.latencyMs = Math.round(latency);
    return out;
  }
}
