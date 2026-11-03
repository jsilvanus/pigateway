import { EventEmitter } from "node:events";

const FRAME_MS = 40;
const TRANSITION_FRAMES = 25;

interface SimMixEffect {
  programInput: number;
  previewInput: number;
  transitionPosition: { inTransition: boolean; remainingFrames: number };
  fadeToBlack: { isFullyBlack: boolean; inTransition: boolean; remainingFrames: number };
}

/**
 * In-memory ATEM for PIGATEWAY_MODE=simulation: same AtemClient seam as the real library client,
 * so the adapter, routes, events and actions behave exactly as with hardware. One M/E, two DSKs.
 */
export class SimulatedAtemClient extends EventEmitter {
  readonly state: {
    video: {
      mixEffects: SimMixEffect[];
      downstreamKeyers: Array<{ onAir: boolean; inTransition: boolean; properties: { tie: boolean } }>;
      auxilliaries: Array<number | undefined>;
    };
  };
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    super();
    this.state = {
      video: {
        mixEffects: [
          {
            programInput: 1,
            previewInput: 2,
            transitionPosition: { inTransition: false, remainingFrames: 0 },
            fadeToBlack: { isFullyBlack: false, inTransition: false, remainingFrames: 0 },
          },
        ],
        downstreamKeyers: [
          { onAir: false, inTransition: false, properties: { tie: false } },
          { onAir: false, inTransition: false, properties: { tie: false } },
        ],
        auxilliaries: [1, 2, undefined],
      },
    };
  }

  async connect(): Promise<void> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.emit("connected");
      this.emit("stateChanged");
    }, 10);
    this.timers.add(t);
  }

  async disconnect(): Promise<void> {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.emit("disconnected");
  }

  private me(index = 0): SimMixEffect {
    const me = this.state.video.mixEffects[index];
    if (!me) throw new RangeError(`no mix effect ${index}`);
    return me;
  }

  private changed(): void {
    this.emit("stateChanged");
  }

  async changeProgramInput(input: number, me = 0): Promise<void> {
    this.me(me).programInput = input;
    this.changed();
  }

  async changePreviewInput(input: number, me = 0): Promise<void> {
    this.me(me).previewInput = input;
    this.changed();
  }

  async cut(me = 0): Promise<void> {
    const m = this.me(me);
    [m.programInput, m.previewInput] = [m.previewInput, m.programInput];
    this.changed();
  }

  async autoTransition(me = 0): Promise<void> {
    const m = this.me(me);
    m.transitionPosition = { inTransition: true, remainingFrames: TRANSITION_FRAMES };
    this.changed();
    const t = setTimeout(() => {
      this.timers.delete(t);
      [m.programInput, m.previewInput] = [m.previewInput, m.programInput];
      m.transitionPosition = { inTransition: false, remainingFrames: 0 };
      this.changed();
    }, TRANSITION_FRAMES * FRAME_MS);
    this.timers.add(t);
  }

  async fadeToBlack(me = 0): Promise<void> {
    const m = this.me(me);
    const toBlack = !m.fadeToBlack.isFullyBlack;
    m.fadeToBlack = { isFullyBlack: m.fadeToBlack.isFullyBlack, inTransition: true, remainingFrames: TRANSITION_FRAMES };
    this.changed();
    const t = setTimeout(() => {
      this.timers.delete(t);
      m.fadeToBlack = { isFullyBlack: toBlack, inTransition: false, remainingFrames: 0 };
      this.changed();
    }, TRANSITION_FRAMES * FRAME_MS);
    this.timers.add(t);
  }

  async setDownstreamKeyTie(tie: boolean, key = 0): Promise<void> {
    const k = this.state.video.downstreamKeyers[key];
    if (!k) throw new RangeError(`no downstream keyer ${key}`);
    k.properties.tie = tie;
    this.changed();
  }

  async setDownstreamKeyOnAir(onAir: boolean, key = 0): Promise<void> {
    const k = this.state.video.downstreamKeyers[key];
    if (!k) throw new RangeError(`no downstream keyer ${key}`);
    k.onAir = onAir;
    this.changed();
  }

  async setAuxSource(source: number, bus = 0): Promise<void> {
    this.state.video.auxilliaries[bus] = source;
    this.changed();
  }

  async uploadStill(): Promise<unknown> {
    return undefined;
  }
  async setMediaPlayerSource(): Promise<void> {}
  async setDownstreamKeyFillSource(): Promise<void> {}
  async setDownstreamKeyCutSource(): Promise<void> {}
}
