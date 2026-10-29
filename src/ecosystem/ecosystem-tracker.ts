import type { AppConfig } from "../config.js";
import type { GatewayEventBroker } from "../events.js";
import type { PiSoundUdpReceiver } from "../pisound/telemetry.js";
import type { PiVoiceUdpReceiver } from "../pivoice/telemetry.js";
import type { YoutubeStatusStore } from "../youtube/youtube-status.js";
import type { AtemAdapter } from "../atem/atem-adapter.js";
import type { EncoderService } from "../encoder/encoder-service.js";
import type { CameraService } from "../camera/camera-service.js";

export interface EcosystemComponent {
  id: string;
  tab: string;
  name: string;
  description: string;
  active: boolean;
  inUse: boolean;
  available: boolean;
  configured: boolean;
  connecting: boolean;
  lastSeenAt: string | null;
  url?: string | null | undefined;
  details?: Record<string, unknown> | undefined;
}

export interface EcosystemStatus {
  service: "pigateway";
  updatedAt: string;
  inUseTabs: string[];
  activePlugins: string[];
  components: Record<string, EcosystemComponent>;
}

export interface EcosystemTrackerOptions {
  config: AppConfig;
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void; debug?: (...args: any[]) => void } | undefined;
  eventBroker?: GatewayEventBroker | undefined;
  pisoundReceiver?: PiSoundUdpReceiver | undefined;
  pivoiceReceiver?: PiVoiceUdpReceiver | undefined;
  youtubeStatus?: YoutubeStatusStore | undefined;
  atemAdapter?: AtemAdapter | undefined;
  encoderService?: EncoderService | undefined;
  cameraService?: CameraService | undefined;
  onPisoundActivate?: (() => Promise<void>) | undefined;
  probeFetch?: ((url: string) => Promise<boolean>) | undefined;
  now?: (() => number) | undefined;
}

export class EcosystemTracker {
  readonly #config: AppConfig;
  readonly #logger: EcosystemTrackerOptions["logger"];
  readonly #eventBroker: GatewayEventBroker | undefined;
  readonly #pisoundReceiver: PiSoundUdpReceiver | undefined;
  readonly #pivoiceReceiver: PiVoiceUdpReceiver | undefined;
  readonly #youtubeStatus: YoutubeStatusStore | undefined;
  readonly #atemAdapter: AtemAdapter | undefined;
  readonly #encoderService: EncoderService | undefined;
  readonly #cameraService: CameraService | undefined;
  readonly #onPisoundActivate: (() => Promise<void>) | undefined;
  readonly #probeFetch: (url: string) => Promise<boolean>;
  readonly #now: () => number;

  #timer: NodeJS.Timeout | null = null;
  #probeInProgress = false;
  #pisoundReceiverStarted = false;
  readonly #sseClients = new Set<string>();

  // Cached availability per service
  readonly #availableMap = new Map<string, boolean>();
  readonly #lastSeenMap = new Map<string, string>();
  #lastSummarySignature = "";

  constructor(options: EcosystemTrackerOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#eventBroker = options.eventBroker;
    this.#pisoundReceiver = options.pisoundReceiver;
    this.#pivoiceReceiver = options.pivoiceReceiver;
    this.#youtubeStatus = options.youtubeStatus;
    this.#atemAdapter = options.atemAdapter;
    this.#encoderService = options.encoderService;
    this.#cameraService = options.cameraService;
    this.#onPisoundActivate = options.onPisoundActivate;
    this.#now = options.now ?? Date.now;

    this.#probeFetch = options.probeFetch ?? (async (url: string) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(600) });
        return res.ok;
      } catch {
        return false;
      }
    });
  }

  markPisoundReceiverStarted(): void {
    this.#pisoundReceiverStarted = true;
    this.#checkAndPublish();
  }

  registerSseClient(identifier: string): () => void {
    const key = identifier.toLowerCase().trim();
    this.#sseClients.add(key);
    this.#checkAndPublish();
    return () => {
      this.#sseClients.delete(key);
      this.#checkAndPublish();
    };
  }

  async shouldStartPisoundReceiver(): Promise<boolean> {
    if (this.#config.pisoundEnabled === true) return true;
    if (this.#config.pisoundEnabled === false) return false;
    if (this.#config.pisoundApiUrl) return true;
    if (this.#config.pisoundUdpPort === 0) return true;

    const probeUrl = `${this.#config.pisoundApiUrl ?? "http://127.0.0.1:3300"}/health`;
    const available = await this.#probeFetch(probeUrl);
    if (available) {
      this.#availableMap.set("pisound", true);
      this.#lastSeenMap.set("pisound", new Date(this.#now()).toISOString());
    }
    return available;
  }

  getSummary(): EcosystemStatus {
    const components: Record<string, EcosystemComponent> = {};

    // 1. PiSound
    const pisoundState = this.#pisoundReceiver?.getState();
    const pisoundConnecting = Boolean(pisoundState?.connected);
    const pisoundAvailable = this.#availableMap.get("pisound") ?? pisoundConnecting;
    const pisoundConfigured = Boolean(this.#config.pisoundApiUrl) || this.#config.pisoundEnabled === true;
    const pisoundInUse = pisoundConnecting || pisoundAvailable || pisoundConfigured;
    if (pisoundConnecting && pisoundState?.lastSeenAt) {
      this.#lastSeenMap.set("pisound", pisoundState.lastSeenAt);
    }
    components.pisound = {
      id: "pisound",
      tab: "sound",
      name: "PiSound Audio DSP",
      description: "BSS Soundweb London audio DSP, wireless and wired microphone management",
      active: pisoundInUse,
      inUse: pisoundInUse,
      available: pisoundAvailable,
      configured: pisoundConfigured,
      connecting: pisoundConnecting,
      lastSeenAt: this.#lastSeenMap.get("pisound") ?? null,
      url: this.#config.pisoundApiUrl ?? "http://127.0.0.1:3300",
      ...(pisoundState ? { details: { mixesCount: pisoundState.mixes.length, channelsCount: pisoundState.channels.length } } : {})
    };

    // 2. PiVoice
    const pivoiceState = this.#pivoiceReceiver?.getState();
    const pivoiceConnecting = Boolean(pivoiceState?.connected);
    const pivoiceAvailable = this.#availableMap.get("pivoice") ?? pivoiceConnecting;
    const pivoiceConfigured = Boolean(this.#config.pivoiceApiUrl);
    const pivoiceInUse = pivoiceConnecting || pivoiceAvailable || pivoiceConfigured;
    if (pivoiceConnecting && pivoiceState?.lastSeenAt) {
      this.#lastSeenMap.set("pivoice", pivoiceState.lastSeenAt);
    }
    components.pivoice = {
      id: "pivoice",
      tab: "voice",
      name: "PiVoice Speech Telemetry",
      description: "Audio capture, VAD speech analysis, and Auditor activity sessions",
      active: pivoiceInUse,
      inUse: pivoiceInUse,
      available: pivoiceAvailable,
      configured: pivoiceConfigured,
      connecting: pivoiceConnecting,
      lastSeenAt: this.#lastSeenMap.get("pivoice") ?? null,
      url: this.#config.pivoiceApiUrl ?? "http://127.0.0.1:8095"
    };

    // 3. PiTube
    const ytState = this.#youtubeStatus?.get();
    const ytConnecting = Boolean(ytState && ytState.state !== "unknown");
    const ytAvailable = this.#availableMap.get("pitube") ?? ytConnecting;
    const ytConfigured = Boolean(this.#config.pitubeApiUrl);
    const ytInUse = ytConnecting || ytAvailable || ytConfigured;
    if (ytConnecting && ytState?.receivedAt) {
      this.#lastSeenMap.set("pitube", new Date(ytState.receivedAt).toISOString());
    }
    components.pitube = {
      id: "pitube",
      tab: "youtube",
      name: "PiTube YouTube Live",
      description: "YouTube broadcast management, stream health, and live captions",
      active: ytInUse,
      inUse: ytInUse,
      available: ytAvailable,
      configured: ytConfigured,
      connecting: ytConnecting,
      lastSeenAt: this.#lastSeenMap.get("pitube") ?? null,
      url: this.#config.pitubeApiUrl ?? "http://127.0.0.1:3105",
      ...(ytState ? { details: { state: ytState.state, ...(ytState.detail ? { detail: ytState.detail } : {}) } } : {})
    };

    // 4. PiLight
    const pilightAvailable = this.#availableMap.get("pilight") ?? false;
    const pilightConfigured = Boolean(this.#config.pilightApiUrl);
    const pilightConnecting = this.#sseClients.has("pilight");
    const pilightInUse = pilightConnecting || pilightAvailable || pilightConfigured;
    components.pilight = {
      id: "pilight",
      tab: "tally",
      name: "PiLight Tally Lights",
      description: "Wireless tally lights (Tally-Ma) and camera director cueing",
      active: pilightInUse,
      inUse: pilightInUse,
      available: pilightAvailable,
      configured: pilightConfigured,
      connecting: pilightConnecting,
      lastSeenAt: this.#lastSeenMap.get("pilight") ?? null,
      url: this.#config.pilightApiUrl ?? "http://127.0.0.1:3200"
    };

    // 5. PiMatrix
    const pimatrixAvailable = this.#availableMap.get("pimatrix") ?? false;
    const pimatrixConfigured = Boolean(this.#config.videoAmxHost) || Boolean(this.#config.pimatrixApiUrl);
    const pimatrixInUse = pimatrixAvailable || pimatrixConfigured;
    components.pimatrix = {
      id: "pimatrix",
      tab: "matrix",
      name: "PiMatrix Video Routing",
      description: "Video routing, display adapters, and AMX line control",
      active: pimatrixInUse,
      inUse: pimatrixInUse,
      available: pimatrixAvailable,
      configured: pimatrixConfigured,
      connecting: false,
      lastSeenAt: this.#lastSeenMap.get("pimatrix") ?? null,
      url: this.#config.pimatrixApiUrl ?? "http://127.0.0.1:3000"
    };

    // 6. PiProgram
    const piprogramAvailable = this.#availableMap.get("piprogram") ?? false;
    const piprogramConfigured = Boolean(this.#config.piprogramApiUrl);
    const piprogramInUse = piprogramAvailable || piprogramConfigured;
    components.piprogram = {
      id: "piprogram",
      tab: "program",
      name: "PiProgram Presentation",
      description: "Hymns, presentation slides, PPTX, and stage displays",
      active: piprogramInUse,
      inUse: piprogramInUse,
      available: piprogramAvailable,
      configured: piprogramConfigured,
      connecting: false,
      lastSeenAt: this.#lastSeenMap.get("piprogram") ?? null,
      url: this.#config.piprogramApiUrl ?? "http://127.0.0.1:3104"
    };

    // 7. PiCanva
    const picanvaAvailable = this.#availableMap.get("picanva") ?? false;
    const picanvaConfigured = Boolean(this.#config.picanvaApiUrl);
    const picanvaInUse = picanvaAvailable || picanvaConfigured;
    components.picanva = {
      id: "picanva",
      tab: "canva",
      name: "PiCanva Slide Bridge",
      description: "Canva design push and presentation navigation",
      active: picanvaInUse,
      inUse: picanvaInUse,
      available: picanvaAvailable,
      configured: picanvaConfigured,
      connecting: false,
      lastSeenAt: this.#lastSeenMap.get("picanva") ?? null,
      url: this.#config.picanvaApiUrl ?? "http://127.0.0.1:3103"
    };

    // 8. Liturgos Auditor
    const auditorAvailable = this.#availableMap.get("auditor") ?? false;
    const auditorConfigured = Boolean(this.#config.auditorUrl);
    const auditorInUse = auditorConfigured || auditorAvailable;
    components.auditor = {
      id: "auditor",
      tab: "transcripts",
      name: "Liturgos Auditor STT",
      description: "Speech-to-text inference and transcription engine",
      active: auditorInUse,
      inUse: auditorInUse,
      available: auditorAvailable,
      configured: auditorConfigured,
      connecting: auditorConfigured,
      lastSeenAt: this.#lastSeenMap.get("auditor") ?? null,
      url: this.#config.auditorUrl ?? "http://127.0.0.1:8090"
    };

    // 8.5. PiRundown
    const pirundownAvailable = this.#availableMap.get("pirundown") ?? false;
    const pirundownConfigured = Boolean(this.#config.pirundownApiUrl);
    const pirundownConnecting = this.#sseClients.has("pirundown");
    const pirundownInUse = pirundownConnecting || pirundownAvailable || pirundownConfigured;
    components.pirundown = {
      id: "pirundown",
      tab: "rundown",
      name: "PiRundown Cue Engine",
      description: "Service rundown, cue matching, and pure human control",
      active: pirundownInUse,
      inUse: pirundownInUse,
      available: pirundownAvailable,
      configured: pirundownConfigured,
      connecting: pirundownConnecting,
      lastSeenAt: this.#lastSeenMap.get("pirundown") ?? null,
      url: this.#config.pirundownApiUrl ?? "http://127.0.0.1:3400"
    };

    // 9. Radio Relay
    const relayConfigured = Boolean(this.#config.radioRelayApiUrl);
    components.radioRelay = {
      id: "radioRelay",
      tab: "radio",
      name: "Web Radio Relay",
      description: "Web radio audio relay stream lifecycle",
      active: relayConfigured,
      inUse: relayConfigured,
      available: relayConfigured,
      configured: relayConfigured,
      connecting: false,
      lastSeenAt: null,
      url: this.#config.radioRelayApiUrl ?? null
    };

    // 10. ATEM Switcher
    const atemState = this.#atemAdapter?.getState();
    const atemConfigured = Boolean(this.#config.atemHost);
    const atemConnected = Boolean(atemState?.connected);
    components.atem = {
      id: "atem",
      tab: "atem",
      name: "ATEM Switcher",
      description: "Blackmagic ATEM video switcher",
      active: atemConfigured || atemConnected,
      inUse: atemConfigured || atemConnected,
      available: atemConnected,
      configured: atemConfigured,
      connecting: atemConnected,
      lastSeenAt: atemConnected ? new Date(this.#now()).toISOString() : null,
      ...(atemState ? { details: { programInput: atemState.programInput, previewInput: atemState.previewInput } } : {})
    };

    // 11. Encoder
    const encoderState = this.#encoderService?.getState();
    const encoderConfigured = Boolean(encoderState?.configured);
    const encoderConnected = Boolean(encoderState?.connected);
    components.encoder = {
      id: "encoder",
      tab: "encoder",
      name: "Matrox Monarch HDX",
      description: "Matrox Monarch HDX dual streaming/recording encoder",
      active: encoderConfigured || encoderConnected,
      inUse: encoderConfigured || encoderConnected,
      available: encoderConnected,
      configured: encoderConfigured,
      connecting: encoderConnected,
      lastSeenAt: encoderConnected ? new Date(this.#now()).toISOString() : null,
      ...(encoderState ? { details: { name: encoderState.name, encoder1: encoderState.encoder1, encoder2: encoderState.encoder2 } } : {})
    };

    // 12. PTZ Cameras
    const cameraList = this.#cameraService?.list() ?? [];
    const camerasConfigured = Boolean(this.#config.cam1Host || this.#config.cam2Host || this.#config.mode === "simulation");
    const camerasInUse = cameraList.length > 0 || camerasConfigured;
    components.cameras = {
      id: "cameras",
      tab: "cameras",
      name: "PTZ Cameras",
      description: "Pan-tilt-zoom cameras via VISCA / CGI",
      active: camerasInUse,
      inUse: camerasInUse,
      available: cameraList.some((c) => c.connection === "connected"),
      configured: camerasConfigured,
      connecting: cameraList.some((c) => c.connection === "connected"),
      lastSeenAt: null,
      details: { count: cameraList.length, cameras: cameraList.map((c) => ({ id: c.id, connection: c.connection })) }
    };

    // 13. AMX NetLinx
    const amxConfigured = this.#config.amxTcpEnabled || Boolean(this.#config.amxMasterHost);
    components.amx = {
      id: "amx",
      tab: "amx",
      name: "AMX NetLinx",
      description: "AMX master control and Atlona matrix switching",
      active: amxConfigured,
      inUse: amxConfigured,
      available: amxConfigured,
      configured: amxConfigured,
      connecting: false,
      lastSeenAt: null
    };

    const inUseTabs: string[] = [];
    const activePlugins: string[] = [];

    for (const comp of Object.values(components)) {
      if (comp.inUse) {
        if (!inUseTabs.includes(comp.tab)) inUseTabs.push(comp.tab);
        activePlugins.push(comp.id);
      }
    }

    return {
      service: "pigateway",
      updatedAt: new Date(this.#now()).toISOString(),
      inUseTabs,
      activePlugins,
      components
    };
  }

  getActivePluginIds(): string[] {
    return this.getSummary().activePlugins;
  }

  getInUseTabs(): string[] {
    return this.getSummary().inUseTabs;
  }

  async probeAll(): Promise<EcosystemStatus> {
    if (this.#probeInProgress) return this.getSummary();
    this.#probeInProgress = true;

    try {
      const probeTargets: Array<{ id: string; url: string }> = [
        { id: "pisound", url: `${this.#config.pisoundApiUrl ?? "http://127.0.0.1:3300"}/health` },
        { id: "pivoice", url: `${this.#config.pivoiceApiUrl ?? "http://127.0.0.1:8095"}/health` },
        { id: "pitube", url: `${this.#config.pitubeApiUrl ?? "http://127.0.0.1:3105"}/health` },
        { id: "pilight", url: `${this.#config.pilightApiUrl ?? "http://127.0.0.1:3200"}/health` },
        { id: "pimatrix", url: `${this.#config.pimatrixApiUrl ?? "http://127.0.0.1:3000"}/health` },
        { id: "piprogram", url: `${this.#config.piprogramApiUrl ?? "http://127.0.0.1:3104"}/health` },
        { id: "picanva", url: `${this.#config.picanvaApiUrl ?? "http://127.0.0.1:3103"}/health` },
        { id: "auditor", url: `${this.#config.auditorUrl ?? "http://127.0.0.1:8090"}/health` },
        { id: "pirundown", url: `${this.#config.pirundownApiUrl ?? "http://127.0.0.1:3400"}/health` }
      ];

      const results = await Promise.allSettled(
        probeTargets.map(async (target) => {
          const ok = await this.#probeFetch(target.url);
          return { id: target.id, ok };
        })
      );

      for (const res of results) {
        if (res.status === "fulfilled") {
          const { id, ok } = res.value;
          this.#availableMap.set(id, ok);
          if (ok) {
            this.#lastSeenMap.set(id, new Date(this.#now()).toISOString());
            if (id === "pisound" && !this.#pisoundReceiverStarted && this.#config.pisoundEnabled !== false) {
              this.#pisoundReceiverStarted = true;
              this.#onPisoundActivate?.().catch((err) => {
                this.#logger?.error({ err }, "Failed to start PiSound UDP receiver after discovery");
              });
            }
          }
        }
      }

      this.#checkAndPublish();
    } finally {
      this.#probeInProgress = false;
    }

    return this.getSummary();
  }

  start(): void {
    if (this.#timer) return;
    const intervalMs = this.#config.ecosystemPollIntervalMs;
    if (intervalMs > 0) {
      this.#timer = setInterval(() => {
        this.probeAll().catch((err) => {
          this.#logger?.warn({ err }, "Periodic ecosystem probe encountered an error");
        });
      }, intervalMs);
      this.#timer.unref?.();
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #checkAndPublish(): void {
    const summary = this.getSummary();
    const signature = summary.activePlugins.sort().join(",") + "|" + summary.inUseTabs.sort().join(",");
    if (signature !== this.#lastSummarySignature) {
      this.#lastSummarySignature = signature;
      this.#eventBroker?.emit({ type: "ecosystem", data: summary });
    }
  }
}
