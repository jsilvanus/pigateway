export interface MatrixRouteConfig {
  /** Atlona matrix input (1..4) */
  input: number;
  /** Atlona matrix output (1..5; 5 = Videomixer) */
  output: number;
}

export interface VideoSourceDefinition {
  id: string;
  name: string;
  mixerInput: number;
  type: "direct" | "matrix" | "rtsp";
  matrixRoute?: MatrixRouteConfig | undefined;
  rtspUrl?: string | undefined;
  aliases?: string[] | undefined;
}

export interface VideoSourceRegistryOptions {
  switchMatrixInput?: number | undefined;
  customSources?: VideoSourceDefinition[] | undefined;
}

export class VideoSourceRegistry {
  private readonly sources = new Map<string, VideoSourceDefinition>();
  private readonly switchMatrixInput: number;

  constructor(options: VideoSourceRegistryOptions = {}) {
    this.switchMatrixInput = options.switchMatrixInput ?? 4;
    this.initDefaults();

    if (options.customSources) {
      for (const s of options.customSources) {
        this.register(s);
      }
    }
  }

  private initDefaults(): void {
    // 1. Direct Camera 1 (Altar)
    this.register({
      id: "cam1",
      name: "Camera 1 (Altar)",
      mixerInput: 1,
      type: "direct",
      aliases: ["1", "camera1", "altar", "alttari"],
    });

    // 2. Direct Camera 2 (Pulpit)
    this.register({
      id: "cam2",
      name: "Camera 2 (Pulpit)",
      mixerInput: 2,
      type: "direct",
      aliases: ["2", "camera2", "pulpit", "saarnatuoli", "ambo"],
    });

    // 3. Direct Camera 3
    this.register({
      id: "cam3",
      name: "Camera 3",
      mixerInput: 3,
      type: "direct",
      aliases: ["3", "camera3"],
    });

    // 4. Pastorphone (Mobile / RTSP camera routed via Atlona input 4 -> output 5)
    this.register({
      id: "pastorphone",
      name: "Pastor Phone (RTSP / Matrix)",
      mixerInput: this.switchMatrixInput,
      type: "matrix",
      matrixRoute: { input: 4, output: 5 },
      rtspUrl: "rtsp://127.0.0.1:8554/pastorphone",
      aliases: ["phone", "pastori", "pastorin_puhelin", "pastor_phone"],
    });

    // 5. Lectern / Lukupulpetti (Atlona input 1 -> output 5)
    this.register({
      id: "lukupulpetti",
      name: "Lukupulpetti (Lectern)",
      mixerInput: this.switchMatrixInput,
      type: "matrix",
      matrixRoute: { input: 1, output: 5 },
      aliases: ["lectern", "reading_desk"],
    });

    // 6. Rack PC (Atlona input 2 -> output 5)
    this.register({
      id: "rackpc",
      name: "Rack PC",
      mixerInput: this.switchMatrixInput,
      type: "matrix",
      matrixRoute: { input: 2, output: 5 },
      aliases: ["pc", "tietokone"],
    });

    // 7. Pi 1 (Hymns / Slides / PiPGM - Atlona input 3 -> output 5)
    this.register({
      id: "pi1",
      name: "Pi 1 (Graphics / Hymns)",
      mixerInput: this.switchMatrixInput,
      type: "matrix",
      matrixRoute: { input: 3, output: 5 },
      aliases: ["pipgm", "hymn"],
    });
  }

  register(source: VideoSourceDefinition): void {
    this.sources.set(source.id.toLowerCase(), source);
  }

  get(idOrAlias: string | number): VideoSourceDefinition | undefined {
    const key = String(idOrAlias).trim().toLowerCase();
    const direct = this.sources.get(key);
    if (direct) return direct;

    for (const source of this.sources.values()) {
      if (source.aliases?.some((a) => a.toLowerCase() === key)) {
        return source;
      }
    }
    return undefined;
  }

  resolve(idOrAlias: string | number): {
    mixerInput: number;
    matrixRoute?: MatrixRouteConfig | undefined;
    source?: VideoSourceDefinition | undefined;
  } {
    const found = this.get(idOrAlias);
    if (found) {
      return {
        mixerInput: found.mixerInput,
        matrixRoute: found.matrixRoute,
        source: found,
      };
    }

    // If pure number (e.g. 1, 2, 4)
    const num = Number(idOrAlias);
    if (!isNaN(num) && num > 0) {
      return { mixerInput: num };
    }

    // Default fallback
    return { mixerInput: 1 };
  }

  list(): VideoSourceDefinition[] {
    return Array.from(this.sources.values());
  }
}
