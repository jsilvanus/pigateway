/**
 * ATEM switcher adapter, built on the `atem-connection` library (the same
 * library and call names lcyt-bridge's AtemPool uses: connect, disconnect,
 * changeProgramInput, changePreviewInput, cut, and the 'connected',
 * 'disconnected', 'stateChanged', 'error' events, with state read from
 * `atem.state.video.mixEffects[me]`).
 *
 * Without a host the adapter is a no-op stub: it never opens a socket and
 * reports connected=false. Hardware behaviour is not verified in this repo.
 */

import { Atem } from "atem-connection";

/** UDP control port used by atem-connection (9910; 9990 is not a control port). */
export const DEFAULT_ATEM_PORT = 9910;

/** How long a connect may stay unconfirmed before a warning is logged. */
export const ATEM_CONNECT_WARN_MS = 5000;

/** First wait before a reconnect after the ATEM drops; doubles up to the maximum. */
export const ATEM_RECONNECT_MIN_MS = 1000;
/** Longest wait between reconnect attempts. */
export const ATEM_RECONNECT_MAX_MS = 30000;

/** The part of a logger the adapter uses (Fastify's logger fits). */
export interface AtemLogger {
  warn(obj: object, msg: string): void;
  info?(obj: object, msg: string): void;
}

export interface AtemTransitionState {
  inTransition: boolean;
  remainingFrames: number;
}

export interface AtemFadeToBlackState {
  /** True once the fade is complete and program is black. */
  fullyBlack: boolean;
  inTransition: boolean;
  remainingFrames: number;
}

export interface AtemDownstreamKeyerState {
  /** 1-based downstream keyer number, as printed on the switcher. */
  dsk: number;
  onAir: boolean;
  /** Tie rides the keyer with the next M/E transition. */
  tie: boolean;
  inTransition: boolean;
}

export interface AtemAdapterState {
  connected: boolean;
  programInput: number | null;
  previewInput: number | null;
  transition: AtemTransitionState;
  fadeToBlack: AtemFadeToBlackState;
  downstreamKeyers: AtemDownstreamKeyerState[];
}

export type AtemStateListener = (state: AtemAdapterState) => void;

/** The subset of the atem-connection client this adapter uses (injectable for tests). */
export interface AtemClient {
  connect(address: string, port?: number): Promise<void>;
  disconnect(): Promise<void>;
  changeProgramInput(input: number, me?: number): Promise<void>;
  changePreviewInput(input: number, me?: number): Promise<void>;
  cut(me?: number): Promise<void>;
  autoTransition?(me?: number): Promise<void>;
  fadeToBlack?(me?: number): Promise<void>;
  setDownstreamKeyTie?(tie: boolean, key?: number): Promise<void>;
  readonly state: unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  /** Media pool and keyer calls used by the slide composite. Optional so older fakes still fit. */
  uploadStill?(index: number, data: Buffer, name: string, description: string): Promise<unknown>;
  setMediaPlayerSource?(props: { sourceType: number; stillIndex: number }, player?: number): Promise<void>;
  setDownstreamKeyFillSource?(input: number, key?: number): Promise<void>;
  setDownstreamKeyCutSource?(input: number, key?: number): Promise<void>;
  setDownstreamKeyOnAir?(onAir: boolean, key?: number): Promise<void>;
}

/** Zero-based media pool slot and DSK/player numbers the library expects. */
export interface AtemDskSetup {
  /** 0-based downstream keyer. */
  dsk: number;
  /** 0-based media player. */
  mediaPlayer: number;
  /** 0-based still slot in the media pool. */
  stillIndex: number;
  /** ATEM input number of the media player's fill. */
  fillInput: number;
  /** ATEM input number of the media player's key (cut). */
  cutInput: number;
}

export interface AtemAdapterOptions {
  /** 0-based M/E index the adapter switches (0 = M/E 1). */
  meIndex?: number;
  /** Creates the library client; tests pass a fake so no socket is opened. */
  createClient?: () => AtemClient;
  /** Receives a warning when the connection fails or is not confirmed in time. */
  logger?: AtemLogger | undefined;
  /** Milliseconds before an unconfirmed connect is reported (default 5 s). */
  connectWarnMs?: number;
  /** Reconnect backoff bounds (defaults: 1 s doubling to 30 s). */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

const IDLE_TRANSITION: AtemTransitionState = { inTransition: false, remainingFrames: 0 };
const IDLE_FTB: AtemFadeToBlackState = { fullyBlack: false, inTransition: false, remainingFrames: 0 };

function assertInput(input: number, name: string): void {
  if (!Number.isInteger(input) || input < 1) {
    throw new RangeError(`${name} must be a positive integer input number`);
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class AtemAdapter {
  private readonly meIndex: number;
  private readonly createClient: () => AtemClient;
  private client: AtemClient | null = null;
  private connected = false;
  private listeners = new Set<AtemStateListener>();
  private readonly logger: AtemLogger | undefined;
  private readonly connectWarnMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  /** Where to reconnect to; set by connect(), cleared by disconnect(). */
  private target: { host: string; port: number } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;

  constructor(options: AtemAdapterOptions = {}) {
    this.meIndex = options.meIndex ?? 0;
    this.createClient = options.createClient ?? (() => new Atem() as unknown as AtemClient);
    this.logger = options.logger;
    this.connectWarnMs = options.connectWarnMs ?? ATEM_CONNECT_WARN_MS;
    this.reconnectMinMs = options.reconnectMinMs ?? ATEM_RECONNECT_MIN_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? ATEM_RECONNECT_MAX_MS;
    this.reconnectDelayMs = this.reconnectMinMs;
  }

  /**
   * Connect to an ATEM. A missing or empty host keeps the adapter a stub
   * (nothing is opened, connected stays false). Once connected, a drop is
   * retried with backoff until disconnect() is called.
   */
  async connect(host?: string, port: number = DEFAULT_ATEM_PORT): Promise<void> {
    const target = host?.trim();
    if (!target) return;
    this.clearReconnectTimer();
    this.target = { host: target, port };
    this.reconnectDelayMs = this.reconnectMinMs;
    await this.open();
  }

  /** Opens one client to the current target. Used by connect() and by reconnect attempts. */
  private async open(): Promise<void> {
    if (!this.target) return;
    const { host: target, port } = this.target;
    if (this.client) {
      const previous = this.client;
      this.client = null;
      this.connected = false;
      try {
        await previous.disconnect();
      } catch {
        /* already gone */
      }
    }

    const client = this.createClient();
    this.client = client;
    const warnTimer = setTimeout(() => {
      if (this.client === client && !this.connected) {
        this.logger?.warn(
          { host: target, port },
          `ATEM not connected after ${this.connectWarnMs} ms; check PIGATEWAY_ATEM_HOST and PIGATEWAY_ATEM_PORT (control port is 9910)`
        );
      }
    }, this.connectWarnMs);
    warnTimer.unref();
    client.on("connected", () => {
      if (this.client !== client) return;
      clearTimeout(warnTimer);
      this.connected = true;
      this.reconnectDelayMs = this.reconnectMinMs;
      this.logger?.info?.({ host: target, port }, "ATEM connected");
      this.emit();
    });
    client.on("disconnected", () => {
      if (this.client !== client) return;
      clearTimeout(warnTimer);
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.logger?.warn({ host: target, port }, "ATEM disconnected");
      this.emit();
      this.scheduleReconnect();
    });
    client.on("stateChanged", () => {
      if (this.client === client && this.connected) this.emit();
    });
    // Logging the error keeps it from becoming an unhandled crash.
    client.on("error", (error: unknown) => {
      if (this.client !== client) return;
      this.logger?.warn({ host: target, port, err: error }, "ATEM connection error");
    });

    try {
      await client.connect(target, port);
    } catch (error) {
      clearTimeout(warnTimer);
      this.logger?.warn({ host: target, port, err: error }, "ATEM connection failed");
      if (this.client === client) this.scheduleReconnect();
      throw error;
    }
  }

  /** Waits, then opens again. The wait doubles after each failed try, up to the maximum. */
  private scheduleReconnect(): void {
    if (!this.target || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectMaxMs, this.reconnectDelayMs * 2);
    this.logger?.info?.({ host: this.target.host, port: this.target.port, delayMs: delay }, "ATEM reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.target) return;
      this.open().catch(() => undefined);
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  async disconnect(): Promise<void> {
    // An explicit disconnect ends the reconnect loop.
    this.target = null;
    this.clearReconnectTimer();
    this.reconnectDelayMs = this.reconnectMinMs;
    const client = this.client;
    this.client = null;
    const wasConnected = this.connected;
    this.connected = false;
    if (client) {
      try {
        await client.disconnect();
      } catch {
        /* already gone */
      }
    }
    if (wasConnected) this.emit();
  }

  getState(): AtemAdapterState {
    if (!this.client || !this.connected) {
      return {
        connected: false,
        programInput: null,
        previewInput: null,
        transition: { ...IDLE_TRANSITION },
        fadeToBlack: { ...IDLE_FTB },
        downstreamKeyers: [],
      };
    }
    const me = readMixEffect(this.client.state, this.meIndex);
    return {
      connected: true,
      programInput: me?.programInput ?? null,
      previewInput: me?.previewInput ?? null,
      transition: me?.transition ?? { ...IDLE_TRANSITION },
      fadeToBlack: me?.fadeToBlack ?? { ...IDLE_FTB },
      downstreamKeyers: readDownstreamKeyers(this.client.state),
    };
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStateChange(listener: AtemStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async setProgram(input: number): Promise<void> {
    assertInput(input, "input");
    const client = this.client;
    if (!client) return;
    this.requireConnected();
    await client.changeProgramInput(input, this.meIndex);
  }

  async setPreview(input: number): Promise<void> {
    assertInput(input, "input");
    const client = this.client;
    if (!client) return;
    this.requireConnected();
    await client.changePreviewInput(input, this.meIndex);
  }

  async cut(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.requireConnected();
    await client.cut(this.meIndex);
  }

  /** Auto (mix) transition of preview to program on the M/E row. */
  async autoTransition(): Promise<void> {
    this.requireConnected();
    const client = this.requireClient();
    if (!client.autoTransition) throw new Error("ATEM client does not support auto transitions");
    await client.autoTransition(this.meIndex);
  }

  /** Fade to black toggle on the M/E row (the switcher fades out, or back in when already black). */
  async fadeToBlack(): Promise<void> {
    this.requireConnected();
    const client = this.requireClient();
    if (!client.fadeToBlack) throw new Error("ATEM client does not support fade to black");
    await client.fadeToBlack(this.meIndex);
  }

  /** Set the tie of a downstream keyer. Zero-based DSK. */
  async setDownstreamKeyTie(dsk: number, tie: boolean): Promise<void> {
    this.requireConnected();
    const client = this.requireClient();
    if (!client.setDownstreamKeyTie) throw new Error("ATEM client does not support keyer control");
    await client.setDownstreamKeyTie(tie, dsk);
  }

  /**
   * Upload a still to the media pool. `rgba` must be raw RGBA at the switcher's video
   * format; the library converts it to the ATEM's YUV and key. Slot numbers are 0-based.
   */
  async uploadStill(stillIndex: number, rgba: Buffer, name: string): Promise<void> {
    this.requireConnected();
    const client = this.requireClient();
    if (!client.uploadStill) throw new Error("ATEM client does not support media pool uploads");
    await client.uploadStill(stillIndex, rgba, name, "pigateway slide");
  }

  /** Point a media player at a still and route its fill and key to a DSK. */
  async setupDownstreamKey(setup: AtemDskSetup): Promise<void> {
    this.requireConnected();
    const client = this.requireClient();
    if (!client.setMediaPlayerSource || !client.setDownstreamKeyFillSource || !client.setDownstreamKeyCutSource) {
      throw new Error("ATEM client does not support keyer control");
    }
    await client.setMediaPlayerSource({ sourceType: 1, stillIndex: setup.stillIndex }, setup.mediaPlayer);
    await client.setDownstreamKeyFillSource(setup.fillInput, setup.dsk);
    await client.setDownstreamKeyCutSource(setup.cutInput, setup.dsk);
  }

  /** Put a DSK on air or take it off. Zero-based DSK. */
  async setDownstreamKeyOnAir(dsk: number, onAir: boolean): Promise<void> {
    this.requireConnected();
    const client = this.requireClient();
    if (!client.setDownstreamKeyOnAir) throw new Error("ATEM client does not support keyer control");
    await client.setDownstreamKeyOnAir(onAir, dsk);
  }

  private requireClient(): AtemClient {
    if (!this.client) throw new Error("ATEM is not connected");
    return this.client;
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("ATEM is not connected");
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) listener(state);
  }
}

interface MixEffectReading {
  programInput: number | null;
  previewInput: number | null;
  transition: AtemTransitionState;
  fadeToBlack: AtemFadeToBlackState;
}

/** Reads the downstream keyers from the library's state object without trusting its shape. */
function readDownstreamKeyers(state: unknown): AtemDownstreamKeyerState[] {
  const keyers = (state as { video?: { downstreamKeyers?: unknown } } | undefined)?.video?.downstreamKeyers;
  if (!Array.isArray(keyers)) return [];
  const result: AtemDownstreamKeyerState[] = [];
  keyers.forEach((raw, index) => {
    const k = raw as { onAir?: unknown; inTransition?: unknown; properties?: { tie?: unknown } } | undefined;
    if (!k) return;
    result.push({
      dsk: index + 1,
      onAir: k.onAir === true,
      tie: k.properties?.tie === true,
      inTransition: k.inTransition === true,
    });
  });
  return result;
}

/** Reads one M/E row from the library's state object without trusting its shape. */
function readMixEffect(state: unknown, meIndex: number): MixEffectReading | null {
  const video = (state as { video?: { mixEffects?: unknown } } | undefined)?.video;
  const mixEffects = video?.mixEffects;
  if (!Array.isArray(mixEffects)) return null;
  const me = mixEffects[meIndex] as
    | {
        programInput?: unknown;
        previewInput?: unknown;
        transitionPosition?: { inTransition?: unknown; remainingFrames?: unknown };
        fadeToBlack?: { isFullyBlack?: unknown; inTransition?: unknown; remainingFrames?: unknown };
      }
    | undefined;
  if (!me) return null;
  const position = me.transitionPosition;
  return {
    programInput: readNumber(me.programInput),
    previewInput: readNumber(me.previewInput),
    transition: {
      inTransition: position?.inTransition === true,
      remainingFrames: readNumber(position?.remainingFrames) ?? 0,
    },
    fadeToBlack: {
      fullyBlack: me.fadeToBlack?.isFullyBlack === true,
      inTransition: me.fadeToBlack?.inTransition === true,
      remainingFrames: readNumber(me.fadeToBlack?.remainingFrames) ?? 0,
    },
  };
}
