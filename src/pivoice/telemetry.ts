import dgram from "node:dgram";

export const PIVOICE_HEADER_BYTES = 20;
export const PIVOICE_PAYLOAD_BYTES = 22;
export const PIVOICE_PACKET_BYTES = PIVOICE_HEADER_BYTES + PIVOICE_PAYLOAD_BYTES;
export const PIVOICE_STALE_MS = 6000;

export type PiVoiceClassification = "unknown" | "silence" | "speech" | "music";
export type PiVoiceCaptureState = "stopped" | "running" | "error";
export type PiVoicePublisherState = "stopped" | "publishing" | "reconnecting" | "error";

export interface PiVoiceTelemetry {
  connected: boolean;
  stale: boolean;
  lastSeenAt: string | null;
  sequence: number | null;
  timestampMs: number | null;
  rmsDbfs: number | null;
  peakDbfs: number | null;
  classification: PiVoiceClassification;
  confidence: number | null;
  capture: {
    state: PiVoiceCaptureState | "unknown";
    sampleFormat: "unknown" | "S16LE" | "S24LE" | "S32LE" | "FLOAT32";
    channels: number | null;
    sampleRateHz: number | null;
  };
  publisher: PiVoicePublisherState | "unknown";
}

const EMPTY_STATE: PiVoiceTelemetry = {
  connected: false,
  stale: true,
  lastSeenAt: null,
  sequence: null,
  timestampMs: null,
  rmsDbfs: null,
  peakDbfs: null,
  classification: "unknown",
  confidence: null,
  capture: { state: "unknown", sampleFormat: "unknown", channels: null, sampleRateHz: null },
  publisher: "unknown"
};

const CLASSIFICATIONS: PiVoiceClassification[] = ["unknown", "silence", "speech", "music"];
const CAPTURE_STATES: PiVoiceCaptureState[] = ["stopped", "running", "error"];
const SAMPLE_FORMATS: PiVoiceTelemetry["capture"]["sampleFormat"][] = ["unknown", "S16LE", "S24LE", "S32LE", "FLOAT32"];
const PUBLISHER_STATES: PiVoicePublisherState[] = ["stopped", "publishing", "reconnecting", "error"];

/** Decode and strictly validate the v1, 42-byte PiVoice telemetry snapshot. */
export function decodePiVoicePacket(packet: Buffer): DecodedPiVoicePacket | null {
  if (packet.length !== PIVOICE_PACKET_BYTES) return null;
  if (packet.toString("ascii", 0, 2) !== "PV" || packet.readUInt8(2) !== 1 || packet.readUInt8(3) !== 1) return null;
  if (packet.readUInt16BE(4) !== 0 || packet.readUInt16BE(6) !== PIVOICE_PAYLOAD_BYTES) return null;
  if (packet.readUInt8(39) !== 0 || packet.readUInt8(40) !== 0 || packet.readUInt8(41) !== 0) return null;

  const classification = CLASSIFICATIONS[packet.readUInt8(28)];
  const confidenceRaw = packet.readUInt8(29);
  const captureState = CAPTURE_STATES[packet.readUInt8(30)];
  const sampleFormat = SAMPLE_FORMATS[packet.readUInt8(31)];
  const publisher = PUBLISHER_STATES[packet.readUInt8(38)];
  const channels = packet.readUInt16BE(32);
  const sampleRateHz = packet.readUInt32BE(34);
  if (!classification || !captureState || !sampleFormat || !publisher) return null;
  if (confidenceRaw > 100 && confidenceRaw !== 255) return null;
  if (captureState === "running" && (channels < 1 || sampleRateHz < 1)) return null;

  const rmsRaw = packet.readInt32BE(20);
  const peakRaw = packet.readInt32BE(24);
  const unavailable = -2147483648;
  const timestampBig = packet.readBigUInt64BE(12);
  if (timestampBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  return {
    sequence: packet.readUInt32BE(8),
    timestampMs: Number(timestampBig),
    rmsDbfs: rmsRaw === unavailable ? null : rmsRaw / 1000,
    peakDbfs: peakRaw === unavailable ? null : peakRaw / 1000,
    classification,
    confidence: confidenceRaw === 255 ? null : confidenceRaw,
    capture: { state: captureState, sampleFormat, channels: channels || null, sampleRateHz: sampleRateHz || null },
    publisher
  };
}

export interface DecodedPiVoicePacket {
  sequence: number;
  timestampMs: number;
  rmsDbfs: number | null;
  peakDbfs: number | null;
  classification: PiVoiceClassification;
  confidence: number | null;
  capture: PiVoiceTelemetry["capture"];
  publisher: PiVoiceTelemetry["publisher"];
}

export interface PiVoiceUdpReceiverOptions {
  host: string;
  port: number;
  allowedIps?: string[] | undefined;
  staleMs?: number;
  now?: () => number;
  logger?: { info: (...args: any[]) => void; error: (...args: any[]) => void };
  onChange?: (state: PiVoiceTelemetry) => void;
}

export class PiVoiceUdpReceiver {
  readonly #options: PiVoiceUdpReceiverOptions;
  readonly #now: () => number;
  readonly #staleMs: number;
  readonly #allowedIps: Set<string> | null;
  #socket: ReturnType<typeof dgram.createSocket> | null = null;
  #staleTimer: NodeJS.Timeout | null = null;
  #lastSeenAtMs: number | null = null;
  #state: PiVoiceTelemetry = structuredClone(EMPTY_STATE);

  constructor(options: PiVoiceUdpReceiverOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#staleMs = options.staleMs ?? PIVOICE_STALE_MS;
    this.#allowedIps = options.allowedIps?.length ? new Set(options.allowedIps.map(normalizeIp)) : null;
  }

  getState(): PiVoiceTelemetry {
    if (this.#lastSeenAtMs === null || this.#now() - this.#lastSeenAtMs >= this.#staleMs) {
      return { ...this.#state, connected: false, stale: true };
    }
    return { ...this.#state, connected: true, stale: false };
  }

  getBoundPort(): number {
    const address = this.#socket?.address();
    return address && typeof address === "object" ? address.port : this.#options.port;
  }

  start(): Promise<void> {
    if (this.#socket) return Promise.resolve();
    const socket = dgram.createSocket("udp4");
    this.#socket = socket;
    socket.on("message", (packet, remote) => {
      if (this.#allowedIps && !this.#allowedIps.has(normalizeIp(remote.address))) return;
      const decoded = decodePiVoicePacket(packet);
      if (!decoded) return;

      const receivedAtMs = this.#now();
      this.#lastSeenAtMs = receivedAtMs;
      this.#state = {
        connected: true,
        stale: false,
        lastSeenAt: new Date(receivedAtMs).toISOString(),
        sequence: decoded.sequence,
        timestampMs: decoded.timestampMs,
        rmsDbfs: decoded.rmsDbfs,
        peakDbfs: decoded.peakDbfs,
        classification: decoded.classification,
        confidence: decoded.confidence,
        capture: decoded.capture,
        publisher: decoded.publisher
      };
      this.#options.onChange?.(this.getState());
    });
    socket.on("error", (error) => this.#options.logger?.error({ err: error }, "PiVoice UDP telemetry receiver error"));
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off("listening", onListening);
        this.#socket = null;
        reject(error);
      };
      const onListening = () => {
        socket.off("error", onError);
        this.#options.logger?.info({ host: this.#options.host, port: this.#options.port }, "PiVoice UDP telemetry receiver listening");
        this.#staleTimer = setInterval(() => {
          if (this.#lastSeenAtMs === null || this.#now() - this.#lastSeenAtMs < this.#staleMs || this.#state.stale) return;
          this.#state = { ...this.#state, connected: false, stale: true };
          this.#options.onChange?.(this.getState());
        }, Math.min(1000, this.#staleMs));
        this.#staleTimer.unref?.();
        resolve();
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(this.#options.port, this.#options.host);
    });
  }

  stop(): Promise<void> {
    if (this.#staleTimer) clearInterval(this.#staleTimer);
    this.#staleTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => socket.close(() => resolve()));
  }
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
