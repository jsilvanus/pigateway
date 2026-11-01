/**
 * Log hygiene for pigateway. Logs may name devices, routes, status codes and timings, never
 * transcript/caption text, personal names, tokens, stream keys or passwords.
 */

/** Pino redact paths (applied to any logged object at these depths). */
export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.x-api-key",
  "headers.authorization",
  "headers.cookie",
  "headers.x-api-key",
  "*.password",
  "*.token",
  "*.apiKey",
  "*.api_key",
  "*.streamKey",
  "*.stream_key",
  "*.secret",
  "*.authorization",
  "*.text",
  "*.transcript",
  "*.caption",
  "*.captions",
  "*.body"
];

/** Drops the query string, fragment and credentials from a URL or path; keeps host and path. */
export function scrubUrl(value: string): string {
  const noQuery = value.split(/[?#]/, 1)[0] ?? "";
  return noQuery.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

const SECRET_WORDS = /(password|passwd|token|secret|api[-_]?key|stream[-_]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s,"'&;]+/gi;
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi;

/** Scrubs free text (error messages): URLs lose query/credentials, key=value secrets are masked. */
export function scrubText(value: string): string {
  return value.replace(URL_IN_TEXT, (m) => scrubUrl(m)).replace(SECRET_WORDS, "$1$2[redacted]");
}

/** Pino serializers: request summaries without headers, query string or body; errors without secrets. */
export const serializers = {
  req(request: { method: string; url: string; routeOptions?: { url?: string | undefined } | undefined; ip: string }) {
    return {
      method: request.method,
      url: scrubUrl(request.routeOptions?.url ?? request.url),
      remoteAddress: request.ip
    };
  },
  res(reply: { statusCode: number }) {
    return { statusCode: reply.statusCode };
  },
  err(error: unknown) {
    if (!(error instanceof Error)) return { type: "NonError", message: scrubText(String(error)), stack: "" };
    const out: { type: string; message: string; stack: string; code?: string | number } = {
      type: error.name,
      message: scrubText(error.message),
      stack: scrubText(error.stack ?? "")
    };
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") out.code = code;
    return out;
  }
};
