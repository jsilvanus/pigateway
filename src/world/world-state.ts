import type { GatewayEventBroker, SpatialScenePayload } from '../events.js';
import type { PiVoiceTelemetry } from '../pivoice/telemetry.js';
import type { PiSoundTelemetry } from '../pisound/telemetry.js';
import type { RundownStatusSnapshot } from '../rundown/rundown-store.js';

export interface WorldStateSpeaker {
  isSpeaking: boolean;
  confidence: number;
  source: 'fusion' | 'voice' | 'dsp' | 'spatial' | 'none';
  person: {
    trackId: number;
    zoneId: string | null;
    zoneName: string | null;
    position: { x: number; y: number; z: number };
  } | null;
  mic: {
    channelIndex: number;
    profile: string;
    signalPresent: boolean;
  } | null;
  vadClassification?: string | undefined;
  vadProbability?: number | null | undefined;
  assignedSpeakerName?: string | null | undefined;
}

export interface WorldState {
  updatedAt: string;
  version: number;
  activeSpeaker: WorldStateSpeaker;
  spatial: {
    available: boolean;
    activeZones: string[];
    subjectsCount: number;
    subjects: Array<{
      trackId: number;
      sourceCameraId: string;
      position: { x: number; y: number; z: number };
      headHeight?: number | undefined;
      zoneId: string | null;
      zoneName: string | null;
      confidence: number;
      label: string;
    }>;
  };
  audio: {
    pivoiceAvailable: boolean;
    isSpeaking: boolean;
    classification: string;
    rmsDbfs: number | null;
    pisoundAvailable: boolean;
    activeChannelsCount: number;
  };
  switcher: {
    available: boolean;
    connected: boolean;
    programInput: number | null;
    previewInput: number | null;
  };
  ceremony: {
    available: boolean;
    loaded: boolean;
    title?: string | undefined;
    currentCueId?: string | undefined;
    currentCueTitle?: string | undefined;
    assignedSpeaker?: string | undefined;
  };
  subsystems: {
    pivoice: boolean;
    pisound: boolean;
    pispace: boolean;
    pirundown: boolean;
    switcher: boolean;
  };
}

export interface WorldStateSources {
  eventBroker?: GatewayEventBroker | undefined;
  getSpatial?: (() => SpatialScenePayload) | undefined;
  getPiVoice?: (() => PiVoiceTelemetry) | undefined;
  getPiSound?: (() => PiSoundTelemetry) | undefined;
  getRundown?: (() => RundownStatusSnapshot) | undefined;
  getAtem?: (() => { connected: boolean; programInput: number | null; previewInput: number | null }) | undefined;
}

export class WorldStateAggregator {
  private current: WorldState;
  private version = 1;
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly sources: WorldStateSources;

  constructor(sources: WorldStateSources = {}) {
    this.sources = sources;
    this.current = this.computeInitialState();

    // Subscribe to gateway events to trigger world state updates
    if (sources.eventBroker) {
      sources.eventBroker.subscribe((evt) => {
        if (
          evt.type === 'spatial' ||
          evt.type === 'spatial-zone' ||
          evt.type === 'pivoice' ||
          evt.type === 'pisound' ||
          evt.type === 'rundown' ||
          evt.type === 'atem'
        ) {
          this.scheduleCompute();
        }
      });
    }
  }

  public get(): WorldState {
    return this.current;
  }

  public scheduleCompute(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.compute();
    }, 40);
    this.debounceTimer.unref?.();
  }

  public compute(): WorldState {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // 1. Query sources safely (fault-tolerant against missing/uninstalled services)
    let spatialScene: SpatialScenePayload | null = null;
    try {
      spatialScene = this.sources.getSpatial?.() ?? null;
    } catch {
      spatialScene = null;
    }

    let pivoice: PiVoiceTelemetry | null = null;
    try {
      pivoice = this.sources.getPiVoice?.() ?? null;
    } catch {
      pivoice = null;
    }

    let pisound: PiSoundTelemetry | null = null;
    try {
      pisound = this.sources.getPiSound?.() ?? null;
    } catch {
      pisound = null;
    }

    let rundown: RundownStatusSnapshot | null = null;
    try {
      rundown = this.sources.getRundown?.() ?? null;
    } catch {
      rundown = null;
    }

    let atem: { connected: boolean; programInput: number | null; previewInput: number | null } | null = null;
    try {
      atem = this.sources.getAtem?.() ?? null;
    } catch {
      atem = null;
    }

    // 2. Evaluate subsystem availability
    const isSpatialFresh = Boolean(
      spatialScene &&
      spatialScene.updatedAt &&
      spatialScene.updatedAt !== new Date(0).toISOString() &&
      nowMs - new Date(spatialScene.updatedAt).getTime() < 30000
    );

    const isVoiceConnected = Boolean(pivoice?.connected && !pivoice?.stale);
    const isSoundConnected = Boolean(pisound?.connected && !pisound?.stale);
    const isRundownLoaded = Boolean(rundown?.loaded);
    const isSwitcherConnected = Boolean(atem?.connected);

    // 3. Audio speaking evaluation
    const isVoiceSpeaking = isVoiceConnected && pivoice?.classification === 'speech';
    const hotChannel = isSoundConnected && pisound?.channels
      ? pisound.channels.find((c) => c.signalPresent && c.isOn !== false)
      : null;

    // 4. Spatial subject evaluation
    const subjects = isSpatialFresh && Array.isArray(spatialScene?.subjects)
      ? spatialScene!.subjects
      : [];

    const activeZones = isSpatialFresh && Array.isArray(spatialScene?.activeZones)
      ? spatialScene!.activeZones
      : [];

    // Find any subject currently positioned in a speech/service zone
    const zonedSubject = subjects.find((s) => s.zoneId != null);

    // 5. Ceremony / Rundown speaker expectation
    const assignedSpeaker = rundown?.loaded ? (rundown as any).currentSpeaker ?? null : null;

    // 6. Sensor Fusion for Active Speaker
    let activeSpeaker: WorldStateSpeaker;

    if (isVoiceSpeaking && zonedSubject) {
      // Best case: Neural VAD detects speech AND camera sees a person in the zone!
      activeSpeaker = {
        isSpeaking: true,
        confidence: Math.round(((pivoice?.confidence ?? 0.85) * 0.5 + zonedSubject.confidence * 0.5) * 100) / 100,
        source: 'fusion',
        person: {
          trackId: zonedSubject.trackId,
          zoneId: zonedSubject.zoneId,
          zoneName: zonedSubject.zoneName,
          position: zonedSubject.position,
        },
        mic: hotChannel
          ? { channelIndex: hotChannel.channelIndex, profile: hotChannel.profile, signalPresent: hotChannel.signalPresent }
          : null,
        vadClassification: pivoice?.classification,
        vadProbability: pivoice?.confidence,
        assignedSpeakerName: assignedSpeaker,
      };
    } else if (hotChannel && zonedSubject) {
      // Audio gate open + spatial subject in zone (e.g. pivoice not installed)
      activeSpeaker = {
        isSpeaking: true,
        confidence: 0.9,
        source: 'fusion',
        person: {
          trackId: zonedSubject.trackId,
          zoneId: zonedSubject.zoneId,
          zoneName: zonedSubject.zoneName,
          position: zonedSubject.position,
        },
        mic: {
          channelIndex: hotChannel.channelIndex,
          profile: hotChannel.profile,
          signalPresent: hotChannel.signalPresent,
        },
        assignedSpeakerName: assignedSpeaker,
      };
    } else if (isVoiceSpeaking) {
      // Speech detected by VAD, but no spatial subject detected (e.g. pispace not installed or subject outside frame)
      activeSpeaker = {
        isSpeaking: true,
        confidence: pivoice?.confidence ?? 0.7,
        source: 'voice',
        person: null,
        mic: hotChannel
          ? { channelIndex: hotChannel.channelIndex, profile: hotChannel.profile, signalPresent: hotChannel.signalPresent }
          : null,
        vadClassification: pivoice?.classification,
        vadProbability: pivoice?.confidence,
        assignedSpeakerName: assignedSpeaker,
      };
    } else if (hotChannel) {
      // DSP mic active, but no VAD or spatial
      activeSpeaker = {
        isSpeaking: true,
        confidence: 0.75,
        source: 'dsp',
        person: null,
        mic: {
          channelIndex: hotChannel.channelIndex,
          profile: hotChannel.profile,
          signalPresent: hotChannel.signalPresent,
        },
        assignedSpeakerName: assignedSpeaker,
      };
    } else if (zonedSubject) {
      // Person standing at pulpit / altar / lectern, but currently silent
      activeSpeaker = {
        isSpeaking: false,
        confidence: zonedSubject.confidence,
        source: 'spatial',
        person: {
          trackId: zonedSubject.trackId,
          zoneId: zonedSubject.zoneId,
          zoneName: zonedSubject.zoneName,
          position: zonedSubject.position,
        },
        mic: null,
        assignedSpeakerName: assignedSpeaker,
      };
    } else {
      // Complete silence / room empty
      activeSpeaker = {
        isSpeaking: false,
        confidence: 0,
        source: 'none',
        person: null,
        mic: null,
        assignedSpeakerName: null,
      };
    }

    const nextState: WorldState = {
      updatedAt: nowIso,
      version: ++this.version,
      activeSpeaker,
      spatial: {
        available: isSpatialFresh,
        activeZones,
        subjectsCount: subjects.length,
        subjects,
      },
      audio: {
        pivoiceAvailable: isVoiceConnected,
        isSpeaking: isVoiceSpeaking,
        classification: pivoice?.classification ?? 'unknown',
        rmsDbfs: pivoice?.rmsDbfs ?? null,
        pisoundAvailable: isSoundConnected,
        activeChannelsCount: pisound?.channels?.filter((c) => c.signalPresent).length ?? 0,
      },
      switcher: {
        available: Boolean(atem),
        connected: isSwitcherConnected,
        programInput: atem?.programInput ?? null,
        previewInput: atem?.previewInput ?? null,
      },
      ceremony: {
        available: isRundownLoaded,
        loaded: isRundownLoaded,
        title: rundown?.title,
        assignedSpeaker: assignedSpeaker ?? undefined,
      },
      subsystems: {
        pivoice: isVoiceConnected,
        pisound: isSoundConnected,
        pispace: isSpatialFresh,
        pirundown: isRundownLoaded,
        switcher: isSwitcherConnected,
      },
    };

    this.current = nextState;

    // Emit event onto Gateway Event Broker
    if (this.sources.eventBroker) {
      this.sources.eventBroker.emit({
        type: 'world-state',
        data: nextState,
      });
    }

    return nextState;
  }

  private computeInitialState(): WorldState {
    return {
      updatedAt: new Date().toISOString(),
      version: 1,
      activeSpeaker: {
        isSpeaking: false,
        confidence: 0,
        source: 'none',
        person: null,
        mic: null,
        assignedSpeakerName: null,
      },
      spatial: {
        available: false,
        activeZones: [],
        subjectsCount: 0,
        subjects: [],
      },
      audio: {
        pivoiceAvailable: false,
        isSpeaking: false,
        classification: 'unknown',
        rmsDbfs: null,
        pisoundAvailable: false,
        activeChannelsCount: 0,
      },
      switcher: {
        available: false,
        connected: false,
        programInput: null,
        previewInput: null,
      },
      ceremony: {
        available: false,
        loaded: false,
      },
      subsystems: {
        pivoice: false,
        pisound: false,
        pispace: false,
        pirundown: false,
        switcher: false,
      },
    };
  }
}
