export type RuntimeMode = "simulation" | "production";

export interface AppConfig {
  host: string;
  port: number;
  mode: RuntimeMode;
  /** API key for mutating /api/v1 calls (PIGATEWAY_API_KEY). Unset = open (development only). */
  apiKey?: string | undefined;
  /** Clients that may skip the key, e.g. the LAN (PIGATEWAY_AUTH_ALLOWED_HOSTS, comma separated). */
  authAllowedHosts?: string[] | undefined;
  /** Browser origins allowed to call /api/v1 cross-origin (PIGATEWAY_CORS_ORIGINS). */
  corsOrigins?: string[] | undefined;
  /** PiVoice binary telemetry listener. */
  pivoiceEnabled?: boolean | undefined;
  pivoiceUdpHost: string;
  pivoiceUdpPort: number;
  pivoiceAllowedHosts?: string[] | undefined;
  /** PiVoice control API; audio never passes through the gateway. */
  pivoiceApiUrl?: string | undefined;
  pivoiceApiToken?: string | undefined;
  /** PiSound audio mixer binary telemetry listener and control API. */
  pisoundEnabled?: boolean | undefined;
  pisoundUdpHost: string;
  pisoundUdpPort: number;
  pisoundAllowedHosts?: string[] | undefined;
  pisoundApiUrl?: string | undefined;
  pisoundApiToken?: string | undefined;
  pitubeApiUrl?: string | undefined;
  pilightApiUrl?: string | undefined;
  pimatrixApiUrl?: string | undefined;
  piprogramApiUrl?: string | undefined;
  picanvaApiUrl?: string | undefined;
  pirundownApiUrl?: string | undefined;
  pirundownDesignerApiUrl?: string | undefined;
  pispaceApiUrl?: string | undefined;
  pigraphicsApiUrl?: string | undefined;
  piperceptionApiUrl?: string | undefined;
  ecosystemPollIntervalMs: number;
  radioRelayApiUrl?: string | undefined;
  radioRelayApiToken?: string | undefined;
  radioRelayStreamName: string;
  pivoiceIdleCloseSeconds: number;
  pivoiceStartWhen: "speech" | "speech_or_music";
  /**
   * How transcripts reach the gateway (PIGATEWAY_TRANSCRIPT_DELIVERY):
   * "sse" = the gateway follows the live session's SSE on the Auditor (needs PIGATEWAY_AUDITOR_URL),
   * "push" = the Auditor POSTs to PIGATEWAY_TRANSCRIPT_PUSH_URL (the address the Auditor uses to reach this gateway).
   */
  transcriptDelivery: "sse" | "push";
  auditorUrl?: string | undefined;
  auditorApiKey?: string | undefined;
  transcriptPushUrl?: string | undefined;
  /** Bearer token the Auditor presents when pushing; defaults to the gateway API key. */
  transcriptPushToken?: string | undefined;
  /** Transcripts kept for SSE replay (PIGATEWAY_TRANSCRIPT_BUFFER). */
  transcriptBuffer: number;
  atemHost?: string | undefined;
  atemPort: number;
  /** Matrox Monarch HDX encoder (PIGATEWAY_ENCODER_HOST, _HTTPS, _USER, _PASSWORD; user and password together). */
  encoderHost?: string | undefined;
  encoderHttps: boolean;
  encoderUser?: string | undefined;
  encoderPassword?: string | undefined;
  /** Near focus limit in metres restored when privacy blur goes off. */
  cameraNearLimitM: number;
  cam1Name: string;
  cam1Host?: string | undefined;
  cam1ViscaPort: number;
  cam1CgiPort: number;
  cam1CgiUser?: string | undefined;
  cam1CgiPassword?: string | undefined;
  cam2Name: string;
  cam2Host?: string | undefined;
  cam2ViscaPort: number;
  cam2CgiPort: number;
  cam2CgiUser?: string | undefined;
  cam2CgiPassword?: string | undefined;
  /** FreeD camera tracking UDP receiver. */
  freedUdpEnabled: boolean;
  freedUdpHost: string;
  freedUdpPort: number;
  freedAllowedHosts?: string[] | undefined;
  /** picam standalone controller service URL (PIGATEWAY_PICAM_API_URL). */
  picamApiUrl?: string | undefined;
  /** piencoder multi-unit hardware encoder service URL (PIGATEWAY_PIENCODER_API_URL). */
  piencoderApiUrl?: string | undefined;
  /** AMX master (NetLinx) that owns the Atlona matrix (PIGATEWAY_AMX_MASTER_HOST/_PORT). */
  amxMasterHost?: string | undefined;
  amxMasterPort: number;
  /** Listener the AMX connects to (PIGATEWAY_AMX_TCP_ENABLED or _PORT; 0 = any free port). */
  amxTcpEnabled: boolean;
  amxTcpHost: string;
  amxTcpPort: number;
  amxAllowedHosts?: string[] | undefined;
  /** Fake AMX replies when no master is configured (PIGATEWAY_AMX_SIMULATED=true). */
  amxSimulated: boolean;
  /** pimatrix's own AMX line listener, where video commands are forwarded (PIGATEWAY_VIDEO_AMX_HOST/_PORT). */
  videoAmxHost?: string | undefined;
  videoAmxPort: number;
  /** MediaMTX bases a camera is told to push to (PIGATEWAY_MEDIAMTX_RTSP_URL / _RTMP_URL). */
  mediaMtxRtspUrl?: string | undefined;
  mediaMtxRtmpUrl?: string | undefined;
  /** Video mixer input connected to Atlona matrix output 5 (PIGATEWAY_SWITCH_MATRIX_INPUT, default 4). */
  switchMatrixInput: number;
}

function validPort(value: string | undefined, fallback: number, name: string, allowZero = false): number {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < (allowZero ? 0 : 1) || result > 65535) {
    throw new Error(`${name} must be an integer between ${allowZero ? 0 : 1} and 65535`);
  }
  return result;
}

function activityTrigger(value: string | undefined): "speech" | "speech_or_music" {
  const result = value ?? "speech_or_music";
  if (result !== "speech" && result !== "speech_or_music") throw new Error("PIGATEWAY_PIVOICE_START_WHEN must be speech or speech_or_music");
  return result;
}

function transcriptDelivery(value: string | undefined): "sse" | "push" {
  const result = value?.trim() || "sse";
  if (result !== "sse" && result !== "push") throw new Error("PIGATEWAY_TRANSCRIPT_DELIVERY must be sse or push");
  return result;
}

function validInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return result;
}

function list(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return items && items.length > 0 ? items : undefined;
}

/** Camera CGI login from PREFIX_USER and PREFIX_PASSWORD. Both or neither. */
function cameraLogin(env: NodeJS.ProcessEnv, prefix: string): { user: string; password: string } | undefined {
  const user = env[`${prefix}_USER`]?.trim() || undefined;
  const password = env[`${prefix}_PASSWORD`]?.trim() || undefined;
  if (!user && !password) return undefined;
  if (!user || !password) {
    throw new Error(`${prefix}_USER and ${prefix}_PASSWORD must be set together`);
  }
  return { user, password };
}

function urlWithScheme(value: string | undefined, name: string, schemes: string[]): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  if (!schemes.includes(url.protocol)) {
    throw new Error(`${name} must start with ${schemes.map((s) => `${s}//`).join(" or ")}`);
  }
  return text.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = env.PIGATEWAY_MODE ?? "simulation";
  if (mode !== "simulation" && mode !== "production") {
    throw new Error('PIGATEWAY_MODE must be "simulation" or "production"');
  }
  const host = env.PIGATEWAY_HOST?.trim() || "127.0.0.1";
  const nearLimit = Number(env.PIGATEWAY_CAMERA_NEAR_LIMIT_M ?? 1.5);
  if (!Number.isFinite(nearLimit) || nearLimit < 0.1 || nearLimit > 50) {
    throw new Error("PIGATEWAY_CAMERA_NEAR_LIMIT_M must be a number of metres between 0.1 and 50");
  }
  const encoderLogin = cameraLogin(env, "PIGATEWAY_ENCODER");
  const cam1Login = cameraLogin(env, "PIGATEWAY_CAM1");
  const cam2Login = cameraLogin(env, "PIGATEWAY_CAM2");
  const pivoiceApiUrl = urlWithScheme(env.PIGATEWAY_PIVOICE_API_URL, "PIGATEWAY_PIVOICE_API_URL", ["http:", "https:"]);
  const pivoiceApiToken = env.PIGATEWAY_PIVOICE_API_TOKEN?.trim() || undefined;
  const pisoundApiUrl = urlWithScheme(env.PIGATEWAY_PISOUND_API_URL, "PIGATEWAY_PISOUND_API_URL", ["http:", "https:"]);
  const pisoundApiToken = env.PIGATEWAY_PISOUND_API_TOKEN?.trim() || undefined;
  const radioRelayApiUrl = urlWithScheme(env.PIGATEWAY_RADIO_RELAY_API_URL, "PIGATEWAY_RADIO_RELAY_API_URL", ["http:", "https:"]);
  const radioRelayApiToken = env.PIGATEWAY_RADIO_RELAY_API_TOKEN?.trim() || undefined;
  if (Boolean(radioRelayApiUrl) !== Boolean(radioRelayApiToken)) throw new Error("PIGATEWAY_RADIO_RELAY_API_URL and PIGATEWAY_RADIO_RELAY_API_TOKEN must be set together");
  if (Boolean(pivoiceApiUrl) !== Boolean(pivoiceApiToken)) {
    throw new Error("PIGATEWAY_PIVOICE_API_URL and PIGATEWAY_PIVOICE_API_TOKEN must be set together");
  }
  const pisoundEnabled =
    env.PIGATEWAY_PISOUND_ENABLED === "true"
      ? true
      : env.PIGATEWAY_PISOUND_ENABLED === "false"
        ? false
        : env.PIGATEWAY_PISOUND_UDP_PORT === "0"
          ? true
          : undefined;
  const pivoiceEnabled = env.PIGATEWAY_PIVOICE_ENABLED === "false" ? false : true;
  const pitubeApiUrl = urlWithScheme(env.PIGATEWAY_PITUBE_API_URL, "PIGATEWAY_PITUBE_API_URL", ["http:", "https:"]);
  const pilightApiUrl = urlWithScheme(env.PIGATEWAY_PILIGHT_API_URL, "PIGATEWAY_PILIGHT_API_URL", ["http:", "https:"]);
  const pimatrixApiUrl = urlWithScheme(env.PIGATEWAY_PIMATRIX_API_URL, "PIGATEWAY_PIMATRIX_API_URL", ["http:", "https:"]);
  const piprogramApiUrl = urlWithScheme(env.PIGATEWAY_PIPROGRAM_API_URL, "PIGATEWAY_PIPROGRAM_API_URL", ["http:", "https:"]);
  const picanvaApiUrl = urlWithScheme(env.PIGATEWAY_PICANVA_API_URL, "PIGATEWAY_PICANVA_API_URL", ["http:", "https:"]);
  const pirundownApiUrl = urlWithScheme(env.PIGATEWAY_PIRUNDOWN_API_URL, "PIGATEWAY_PIRUNDOWN_API_URL", ["http:", "https:"]);
  const pirundownDesignerApiUrl = urlWithScheme(env.PIGATEWAY_PIRUNDOWN_DESIGNER_API_URL, "PIGATEWAY_PIRUNDOWN_DESIGNER_API_URL", ["http:", "https:"]);
  const pispaceApiUrl = urlWithScheme(env.PIGATEWAY_PISPACE_API_URL, "PIGATEWAY_PISPACE_API_URL", ["http:", "https:"]);
  const pigraphicsApiUrl = urlWithScheme(env.PIGATEWAY_PIGRAPHICS_API_URL, "PIGATEWAY_PIGRAPHICS_API_URL", ["http:", "https:"]);
  const piperceptionApiUrl = urlWithScheme(env.PIGATEWAY_PIPERCEPTION_API_URL, "PIGATEWAY_PIPERCEPTION_API_URL", ["http:", "https:"]);
  const ecosystemPollIntervalMs = validInteger(env.PIGATEWAY_ECOSYSTEM_POLL_INTERVAL_MS, 15000, 0, 3600000, "PIGATEWAY_ECOSYSTEM_POLL_INTERVAL_MS");

  return {
    host,
    port: validPort(env.PIGATEWAY_PORT, 3100, "PIGATEWAY_PORT"),
    mode,
    apiKey: env.PIGATEWAY_API_KEY?.trim() || undefined,
    authAllowedHosts: list(env.PIGATEWAY_AUTH_ALLOWED_HOSTS),
    corsOrigins: list(env.PIGATEWAY_CORS_ORIGINS),
    pivoiceEnabled,
    pivoiceUdpHost: env.PIGATEWAY_PIVOICE_UDP_HOST?.trim() || "0.0.0.0",
    pivoiceUdpPort: validPort(env.PIGATEWAY_PIVOICE_UDP_PORT, 3101, "PIGATEWAY_PIVOICE_UDP_PORT", true),
    pivoiceAllowedHosts: list(env.PIGATEWAY_PIVOICE_ALLOWED_HOSTS),
    pivoiceApiUrl,
    pivoiceApiToken,
    pisoundEnabled,
    pisoundUdpHost: env.PIGATEWAY_PISOUND_UDP_HOST?.trim() || "0.0.0.0",
    pisoundUdpPort: validPort(env.PIGATEWAY_PISOUND_UDP_PORT, 3102, "PIGATEWAY_PISOUND_UDP_PORT", true),
    pisoundAllowedHosts: list(env.PIGATEWAY_PISOUND_ALLOWED_HOSTS),
    pisoundApiUrl,
    pisoundApiToken,
    pitubeApiUrl,
    pilightApiUrl,
    pimatrixApiUrl,
    piprogramApiUrl,
    picanvaApiUrl,
    pirundownApiUrl,
    pirundownDesignerApiUrl,
    pispaceApiUrl,
    pigraphicsApiUrl,
    piperceptionApiUrl,
    ecosystemPollIntervalMs,
    radioRelayApiUrl,
    radioRelayApiToken,
    radioRelayStreamName: env.PIGATEWAY_RADIO_RELAY_STREAM_NAME?.trim() || "stream",
    pivoiceIdleCloseSeconds: validInteger(env.PIGATEWAY_PIVOICE_IDLE_CLOSE_SECONDS, 15, 0, 3600, "PIGATEWAY_PIVOICE_IDLE_CLOSE_SECONDS"),
    pivoiceStartWhen: activityTrigger(env.PIGATEWAY_PIVOICE_START_WHEN),
    transcriptDelivery: transcriptDelivery(env.PIGATEWAY_TRANSCRIPT_DELIVERY),
    auditorUrl: urlWithScheme(env.PIGATEWAY_AUDITOR_URL, "PIGATEWAY_AUDITOR_URL", ["http:", "https:"]),
    auditorApiKey: env.PIGATEWAY_AUDITOR_API_KEY?.trim() || undefined,
    transcriptPushUrl: urlWithScheme(env.PIGATEWAY_TRANSCRIPT_PUSH_URL, "PIGATEWAY_TRANSCRIPT_PUSH_URL", ["http:", "https:"]),
    transcriptPushToken: env.PIGATEWAY_TRANSCRIPT_PUSH_TOKEN?.trim() || env.PIGATEWAY_API_KEY?.trim() || undefined,
    transcriptBuffer: validInteger(env.PIGATEWAY_TRANSCRIPT_BUFFER, 500, 10, 10000, "PIGATEWAY_TRANSCRIPT_BUFFER"),
    atemHost: env.PIGATEWAY_ATEM_HOST?.trim() || undefined,
    atemPort: validPort(env.PIGATEWAY_ATEM_PORT, 9910, "PIGATEWAY_ATEM_PORT"),
    encoderHost: env.PIGATEWAY_ENCODER_HOST?.trim() || undefined,
    encoderHttps: env.PIGATEWAY_ENCODER_HTTPS === "true",
    encoderUser: encoderLogin?.user,
    encoderPassword: encoderLogin?.password,
    cameraNearLimitM: nearLimit,
    cam1Name: env.PIGATEWAY_CAM1_NAME?.trim() || "Camera 1",
    cam1Host: env.PIGATEWAY_CAM1_HOST?.trim() || undefined,
    cam1ViscaPort: validPort(env.PIGATEWAY_CAM1_VISCA_PORT, 52381, "PIGATEWAY_CAM1_VISCA_PORT"),
    cam1CgiPort: validPort(env.PIGATEWAY_CAM1_CGI_PORT, 80, "PIGATEWAY_CAM1_CGI_PORT"),
    cam1CgiUser: cam1Login?.user,
    cam1CgiPassword: cam1Login?.password,
    cam2Name: env.PIGATEWAY_CAM2_NAME?.trim() || "Camera 2",
    cam2Host: env.PIGATEWAY_CAM2_HOST?.trim() || undefined,
    cam2ViscaPort: validPort(env.PIGATEWAY_CAM2_VISCA_PORT, 52381, "PIGATEWAY_CAM2_VISCA_PORT"),
    cam2CgiPort: validPort(env.PIGATEWAY_CAM2_CGI_PORT, 80, "PIGATEWAY_CAM2_CGI_PORT"),
    cam2CgiUser: cam2Login?.user,
    cam2CgiPassword: cam2Login?.password,
        freedUdpEnabled:
      env.PIGATEWAY_FREED_UDP_ENABLED === "true"
        ? true
        : env.PIGATEWAY_FREED_UDP_ENABLED === "false"
          ? false
          : mode === "production" || env.PIGATEWAY_FREED_UDP_PORT === "0",
    freedUdpHost: env.PIGATEWAY_FREED_UDP_HOST?.trim() || "0.0.0.0",
    freedUdpPort: validPort(env.PIGATEWAY_FREED_UDP_PORT, 40000, "PIGATEWAY_FREED_UDP_PORT", true),
    freedAllowedHosts: list(env.PIGATEWAY_FREED_ALLOWED_HOSTS),
    picamApiUrl: urlWithScheme(env.PIGATEWAY_PICAM_API_URL, "PIGATEWAY_PICAM_API_URL", ["http:", "https:"]),
    piencoderApiUrl: urlWithScheme(env.PIGATEWAY_PIENCODER_API_URL, "PIGATEWAY_PIENCODER_API_URL", ["http:", "https:"]),
    amxMasterHost: env.PIGATEWAY_AMX_MASTER_HOST?.trim() || undefined,
    amxMasterPort: validPort(env.PIGATEWAY_AMX_MASTER_PORT, 6501, "PIGATEWAY_AMX_MASTER_PORT"),
    amxTcpEnabled: env.PIGATEWAY_AMX_TCP_ENABLED === "true" || env.PIGATEWAY_AMX_TCP_PORT !== undefined,
    amxTcpHost: env.PIGATEWAY_AMX_TCP_HOST?.trim() || "127.0.0.1",
    amxTcpPort: validPort(env.PIGATEWAY_AMX_TCP_PORT, 6600, "PIGATEWAY_AMX_TCP_PORT", true),
    amxAllowedHosts: list(env.PIGATEWAY_AMX_ALLOWED_HOSTS),
    amxSimulated: env.PIGATEWAY_AMX_SIMULATED === "true",
    videoAmxHost: env.PIGATEWAY_VIDEO_AMX_HOST?.trim() || undefined,
    videoAmxPort: validPort(env.PIGATEWAY_VIDEO_AMX_PORT, 6601, "PIGATEWAY_VIDEO_AMX_PORT"),
    mediaMtxRtspUrl: urlWithScheme(env.PIGATEWAY_MEDIAMTX_RTSP_URL, "PIGATEWAY_MEDIAMTX_RTSP_URL", ["rtsp:", "rtsps:"]),
    mediaMtxRtmpUrl: urlWithScheme(env.PIGATEWAY_MEDIAMTX_RTMP_URL, "PIGATEWAY_MEDIAMTX_RTMP_URL", ["rtmp:", "rtmps:"]),
    switchMatrixInput: Number(env.PIGATEWAY_SWITCH_MATRIX_INPUT || 4),
  };
}
