import dgram from "node:dgram";

export const PISOUND_MAGIC = 0x5053; // "PS"
export const PISOUND_VERSION = 1;
export const PISOUND_TYPE_SNAPSHOT = 0x01;
export const PISOUND_STALE_MS = 6000;

export interface TelemetryMixSummary {
  id: string;
  controlType: "gain" | "toggle";
  masterVolume: number; // 0..100
  masterMuted: boolean;
}

export interface TelemetryChannelInput {
  channelIndex: number;
  peakMilliDbfs: number;
  profile: string;
  signalPresent: boolean;
  agcActive: boolean;
  isOn: boolean;
  mixSends: Record<string, { enabled: boolean; volumePercent: number }>;
}

export interface PiSoundTelemetry {
  connected: boolean;
  stale: boolean;
  lastSeenAt: string | null;
  sequence: number | null;
  timestampMs: number | null;
  activeTalkersMask: number;
  mixes: TelemetryMixSummary[];
  channels: TelemetryChannelInput[];
}

export const EMPTY_PISOUND_STATE: PiSoundTelemetry = {
  connected: false,
  stale: true,
  lastSeenAt: null,
  sequence: null,
  timestampMs: null,
  activeTalkersMask: 0,
  mixes: [],
  channels: []
};

const INDEX_PROFILE_MAP: Record<number, string> = {
  0: "speech",
  1: "vocal",
  2: "guitar",
  3: "piano",
  4: "choir",
  5: "organ",
  6: "drums",
  7: "ambient",
  8: "custom"
};

export interface DecodedPiSoundPacket {
  sequence: number;
  timestampMs: number;
  activeTalkersMask: number;
  mixes: TelemetryMixSummary[];
  channels: TelemetryChannelInput[];
}

/** Decode and validate a binary wire packet from PiSound. */
export function decodePiSoundPacket(buf: Buffer): DecodedPiSoundPacket | null {
  if (buf.length < 24) return null;

  let offset = 0;
  const magic = buf.readUInt16BE(offset);
  offset += 2;
  if (magic !== PISOUND_MAGIC) return null;

  const version = buf.readUInt8(offset);
  offset += 1;
  if (version !== PISOUND_VERSION) return null;

  const type = buf.readUInt8(offset);
  offset += 1;
  if (type !== PISOUND_TYPE_SNAPSHOT) return null;

  // Reserved flags (2 bytes)
  offset += 2;

  const sequence = buf.readUInt32BE(offset);
  offset += 4;
  const timestampMs = Number(buf.readBigUInt64BE(offset));
  offset += 8;
  const mixCount = buf.readUInt8(offset);
  offset += 1;
  const channelCount = buf.readUInt8(offset);
  offset += 1;
  const activeTalkersMask = buf.readUInt32BE(offset);
  offset += 4;

  const mixes: TelemetryMixSummary[] = [];
  for (let i = 0; i < mixCount; i++) {
    if (offset >= buf.length) return null;
    const idLen = buf.readUInt8(offset);
    offset += 1;
    if (offset + idLen + 3 > buf.length) return null;

    const id = buf.toString("utf8", offset, offset + idLen);
    offset += idLen;

    const controlTypeCode = buf.readUInt8(offset);
    offset += 1;
    const masterVolume = buf.readUInt8(offset);
    offset += 1;
    const masterMuted = buf.readUInt8(offset) !== 0;
    offset += 1;

    mixes.push({
      id,
      controlType: controlTypeCode === 1 ? "gain" : "toggle",
      masterVolume,
      masterMuted
    });
  }

  const channels: TelemetryChannelInput[] = [];
  const channelRecordSize = 1 + 4 + 1 + 1 + mixCount;

  for (let c = 0; c < channelCount; c++) {
    if (offset + channelRecordSize > buf.length) return null;

    const channelIndex = buf.readUInt8(offset);
    offset += 1;
    const peakMilliDbfs = buf.readInt32BE(offset);
    offset += 4;
    const profCode = buf.readUInt8(offset);
    offset += 1;
    const profile = INDEX_PROFILE_MAP[profCode] || "custom";

    const flags = buf.readUInt8(offset);
    offset += 1;
    const signalPresent = (flags & 0x01) !== 0;
    const agcActive = (flags & 0x02) !== 0;
    const isOn = (flags & 0x04) !== 0;

    const mixSends: Record<string, { enabled: boolean; volumePercent: number }> = {};
    for (let i = 0; i < mixCount; i++) {
      const sendByte = buf.readUInt8(offset);
      offset += 1;
      const enabled = (sendByte & 0x80) !== 0;
      const volumePercent = sendByte & 0x7f;
      const mixId = mixes[i]?.id ?? `mix${i}`;
      mixSends[mixId] = { enabled, volumePercent };
    }

    channels.push({
      channelIndex,
      peakMilliDbfs,
      profile,
      signalPresent,
      agcActive,
      isOn,
      mixSends
    });
  }

  return {
    sequence,
    timestampMs,
    activeTalkersMask,
    mixes,
    channels
  };
}

export interface PiSoundUdpReceiverOptions {
  host: string;
  port: number;
  allowedIps?: string[] | undefined;
  staleMs?: number;
  now?: () => number;
  logger?: { info: (...args: any[]) => void; error: (...args: any[]) => void };
  onChange?: (state: PiSoundTelemetry) => void;
}

export class PiSoundUdpReceiver {
  readonly #options: PiSoundUdpReceiverOptions;
  readonly #now: () => number;
  readonly #staleMs: number;
  readonly #allowedIps: Set<string> | null;
  #socket: ReturnType<typeof dgram.createSocket> | null = null;
  #staleTimer: NodeJS.Timeout | null = null;
  #lastSeenAtMs: number | null = null;
  #lastSeenAtIso: string | null = null;
  #state: PiSoundTelemetry = structuredClone(EMPTY_PISOUND_STATE);

  constructor(options: PiSoundUdpReceiverOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#staleMs = options.staleMs ?? PISOUND_STALE_MS;
    this.#allowedIps = options.allowedIps?.length ? new Set(options.allowedIps.map(normalizeIp)) : null;
  }

  getState(): PiSoundTelemetry {
    if (this.#lastSeenAtMs === null || this.#now() - this.#lastSeenAtMs >= this.#staleMs) {
      return { ...this.#state, connected: false, stale: true };
    }
    if (!this.#lastSeenAtIso && this.#lastSeenAtMs !== null) {
      this.#lastSeenAtIso = new Date(this.#lastSeenAtMs).toISOString();
    }
    return { ...this.#state, connected: true, stale: false, lastSeenAt: this.#lastSeenAtIso ?? this.#state.lastSeenAt };
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
      if (packet.length < 24) return;

      const decoded = decodePiSoundPacket(packet);
      if (!decoded) return;

      const receivedAtMs = this.#now();
      this.#lastSeenAtMs = receivedAtMs;
      this.#lastSeenAtIso = new Date(receivedAtMs).toISOString();
      this.#state = {
        connected: true,
        stale: false,
        lastSeenAt: this.#lastSeenAtIso,
        sequence: decoded.sequence,
        timestampMs: decoded.timestampMs,
        activeTalkersMask: decoded.activeTalkersMask,
        mixes: decoded.mixes,
        channels: decoded.channels
      };
      this.#options.onChange?.(this.getState());
    });

    socket.on("error", (error) => this.#options.logger?.error({ err: error }, "PiSound UDP telemetry receiver error"));

    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off("listening", onListening);
        this.#socket = null;
        reject(error);
      };
      const onListening = () => {
        socket.off("error", onError);
        this.#options.logger?.info({ host: this.#options.host, port: this.#options.port }, "PiSound UDP telemetry receiver listening");
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
    this.#lastSeenAtIso = null;
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => socket.close(() => resolve()));
  }
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
