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
  pivoiceUdpHost: string;
  pivoiceUdpPort: number;
  pivoiceAllowedHosts?: string[] | undefined;
  /** PiVoice control API; audio never passes through the gateway. */
  pivoiceApiUrl?: string | undefined;
  pivoiceApiToken?: string | undefined;
  pivoiceIdleCloseSeconds: number;
  pivoiceStartWhen: "speech" | "speech_or_music";
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
  if (Boolean(pivoiceApiUrl) !== Boolean(pivoiceApiToken)) {
    throw new Error("PIGATEWAY_PIVOICE_API_URL and PIGATEWAY_PIVOICE_API_TOKEN must be set together");
  }
  return {
    host,
    port: validPort(env.PIGATEWAY_PORT, 3100, "PIGATEWAY_PORT"),
    mode,
    apiKey: env.PIGATEWAY_API_KEY?.trim() || undefined,
    authAllowedHosts: list(env.PIGATEWAY_AUTH_ALLOWED_HOSTS),
    corsOrigins: list(env.PIGATEWAY_CORS_ORIGINS),
    pivoiceUdpHost: env.PIGATEWAY_PIVOICE_UDP_HOST?.trim() || "0.0.0.0",
    pivoiceUdpPort: validPort(env.PIGATEWAY_PIVOICE_UDP_PORT, 3101, "PIGATEWAY_PIVOICE_UDP_PORT"),
    pivoiceAllowedHosts: list(env.PIGATEWAY_PIVOICE_ALLOWED_HOSTS),
    pivoiceApiUrl,
    pivoiceApiToken,
    pivoiceIdleCloseSeconds: validInteger(env.PIGATEWAY_PIVOICE_IDLE_CLOSE_SECONDS, 15, 0, 3600, "PIGATEWAY_PIVOICE_IDLE_CLOSE_SECONDS"),
    pivoiceStartWhen: activityTrigger(env.PIGATEWAY_PIVOICE_START_WHEN),
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
    mediaMtxRtmpUrl: urlWithScheme(env.PIGATEWAY_MEDIAMTX_RTMP_URL, "PIGATEWAY_MEDIAMTX_RTMP_URL", ["rtmp:", "rtmps:"])
  };
}
