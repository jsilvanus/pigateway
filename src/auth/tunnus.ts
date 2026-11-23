import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TunnusClaims {
  sub: string;
  name?: string | undefined;
  email?: string | undefined;
  groups: string[];
  /** The raw payload, for logs that need more. Never log the token itself. */
  payload: Record<string, unknown>;
}

export class TunnusAuthError extends Error {
  constructor(message: string, public readonly code: "INVALID_TOKEN" | "JWKS_UNAVAILABLE" = "INVALID_TOKEN") {
    super(message);
    this.name = "TunnusAuthError";
  }
}

export interface TunnusVerifierOptions {
  /** The Tunnus issuer URL: the `iss` claim must equal it (a trailing slash is ignored). */
  issuer: string;
  /** This service's name; the token's `aud` (a string or an array) must contain it. */
  audience: string;
  /** Overrides discovery (default: `jwks_uri` of `<issuer>/.well-known/openid-configuration`). */
  jwksUri?: string | undefined;
  /** Keeps the last good key set so a restart while the internet is down can still verify tokens. */
  jwksCacheFile?: string | undefined;
  /** How long a fetched key set is trusted before it is refreshed (default 10 minutes). */
  jwksTtlMs?: number | undefined;
  /** Seconds of clock skew allowed on exp and nbf (default 30). */
  leewaySeconds?: number | undefined;
  fetchFn?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

export interface TunnusVerifier {
  readonly issuer: string;
  readonly audience: string;
  verify(token: string): Promise<TunnusClaims>;
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

const b64 = (part: string) => Buffer.from(part, "base64url");

/** Reads the `iss` of a JWT without verifying it, only to decide which verifier should look at it. */
export function peekIssuer(token: string): string | undefined {
  try {
    const iss = (JSON.parse(b64(token.split(".")[1] ?? "").toString("utf8")) as { iss?: unknown }).iss;
    return typeof iss === "string" ? iss.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verifies a Tunnus access token (RS256 JWT): signature against the issuer's JWKS, `iss`, `exp`, `nbf` and `aud` containing
 * this service. Rights are not read here: the caller maps `groups` to rights. The JWKS is cached in memory, optionally in a
 * file, and refreshed once (at most every 30 s) when a token names an unknown `kid`, so key rotation works.
 */
export function createTunnusVerifier(options: TunnusVerifierOptions): TunnusVerifier {
  const issuer = options.issuer.replace(/\/+$/, "");
  if (!issuer) throw new Error("A Tunnus issuer is required");
  if (!options.audience) throw new Error("A Tunnus audience is required");
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const ttl = options.jwksTtlMs ?? 10 * 60_000;
  const leeway = options.leewaySeconds ?? 30;
  let keys: Jwk[] | undefined;
  let fetchedAt = 0;
  let lastAttempt = -Infinity;
  let jwksUri = options.jwksUri;

  if (options.jwksCacheFile) {
    try {
      const cached = JSON.parse(readFileSync(options.jwksCacheFile, "utf8")) as { keys?: Jwk[] };
      if (Array.isArray(cached.keys)) keys = cached.keys;
    } catch {
      // no cache yet
    }
  }

  async function getJson(url: string): Promise<unknown> {
    const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  }

  async function refresh(): Promise<void> {
    lastAttempt = now();
    try {
      if (!jwksUri) {
        const doc = (await getJson(`${issuer}/.well-known/openid-configuration`)) as { jwks_uri?: unknown };
        if (typeof doc.jwks_uri !== "string") throw new Error("discovery has no jwks_uri");
        jwksUri = doc.jwks_uri;
      }
      const set = (await getJson(jwksUri)) as { keys?: Jwk[] };
      if (!Array.isArray(set.keys)) throw new Error("JWKS has no keys");
      keys = set.keys;
      fetchedAt = now();
      if (options.jwksCacheFile) {
        try {
          mkdirSync(dirname(options.jwksCacheFile), { recursive: true });
          writeFileSync(options.jwksCacheFile, JSON.stringify({ keys }), { mode: 0o600 });
        } catch {
          // the cache is optional
        }
      }
    } catch (err) {
      // Keep serving the keys we have; only fail when there are none.
      if (!keys) throw new TunnusAuthError(`Cannot fetch Tunnus keys: ${(err as Error).message}`, "JWKS_UNAVAILABLE");
    }
  }

  async function keyFor(kid: string | undefined): Promise<Jwk | undefined> {
    const find = () => keys?.find((k) => k.kty === "RSA" && (k.use === undefined || k.use === "sig") && (kid === undefined || k.kid === kid));
    if (!keys || now() - fetchedAt > ttl) await refresh();
    let key = find();
    // Unknown kid: the keys may have rotated. Refetch, but not more often than every 30 s.
    if (!key && now() - lastAttempt > 30_000) {
      await refresh();
      key = find();
    }
    return key;
  }

  return {
    issuer,
    audience: options.audience,
    async verify(token) {
      const parts = token.split(".");
      if (parts.length !== 3) throw new TunnusAuthError("Not a JWT");
      let header: { alg?: unknown; kid?: unknown };
      let payload: Record<string, unknown>;
      try {
        header = JSON.parse(b64(parts[0]!).toString("utf8"));
        payload = JSON.parse(b64(parts[1]!).toString("utf8"));
      } catch {
        throw new TunnusAuthError("Malformed token");
      }
      if (header.alg !== "RS256") throw new TunnusAuthError("Only RS256 tokens are accepted");
      const jwk = await keyFor(typeof header.kid === "string" ? header.kid : undefined);
      if (!jwk) throw new TunnusAuthError("Unknown signing key");
      const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), b64(parts[2]!));
      if (!ok) throw new TunnusAuthError("Bad signature");
      if (typeof payload.iss !== "string" || payload.iss.replace(/\/+$/, "") !== issuer) throw new TunnusAuthError("Wrong issuer");
      const aud = payload.aud;
      const audiences = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
      if (!audiences.includes(options.audience)) throw new TunnusAuthError("Token is not for this service");
      const nowSec = Math.floor(now() / 1000);
      if (typeof payload.exp !== "number" || payload.exp + leeway < nowSec) throw new TunnusAuthError("Token has expired");
      if (typeof payload.nbf === "number" && payload.nbf - leeway > nowSec) throw new TunnusAuthError("Token is not valid yet");
      if (typeof payload.sub !== "string" || !payload.sub) throw new TunnusAuthError("Token has no subject");
      const groups = Array.isArray(payload.groups) ? payload.groups.filter((g): g is string => typeof g === "string") : [];
      return {
        sub: payload.sub,
        name: typeof payload.name === "string" ? payload.name : undefined,
        email: typeof payload.email === "string" ? payload.email : undefined,
        groups,
        payload
      };
    }
  };
}
