import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

export const DEFAULT_OIDC_ISSUER = "https://kehitys.riihimaenseurakunta.fi/identity";
export const DEFAULT_OIDC_CLIENT_ID = "pigateway";
export const DEFAULT_OIDC_AUDIENCES = ["pigateway", "picontrol-mcp"];

export const OIDC_GROUPS = {
  ADMIN: "parish/riihimaki/picontrol-admin",
  OPERATOR: "parish/riihimaki/picontrol-operator",
  VIEWER: "parish/riihimaki/picontrol-viewer",
  CANVA_WRITE: "parish/riihimaki/canva-write",
  CANVA_OPERATE: "parish/riihimaki/canva-operate"
} as const;

export interface OidcUser {
  sub: string;
  email?: string | undefined;
  name?: string | undefined;
  groups: string[];
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
  canCanva: boolean;
}

export interface OidcVerifierOptions {
  issuer?: string | undefined;
  clientId?: string | undefined;
  audiences?: string[] | undefined;
  jwksUri?: string | undefined;
  jwksOverride?: JWTVerifyGetKey | undefined;
}

export class OidcAuthError extends Error {
  constructor(message: string, public readonly statusCode = 401) {
    super(message);
    this.name = "OidcAuthError";
  }
}

export class OidcForbiddenError extends OidcAuthError {
  constructor(message: string) {
    super(message, 403);
    this.name = "OidcForbiddenError";
  }
}

function normalizeGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string").map((s) => s.trim());
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export class OidcVerifier {
  readonly issuer: string;
  readonly clientId: string;
  readonly audiences: string[];
  readonly #jwks: JWTVerifyGetKey;

  constructor(options: OidcVerifierOptions = {}) {
    this.issuer = options.issuer?.replace(/\/+$/, "") || DEFAULT_OIDC_ISSUER;
    this.clientId = options.clientId?.trim() || DEFAULT_OIDC_CLIENT_ID;
    this.audiences = options.audiences && options.audiences.length > 0 ? options.audiences : DEFAULT_OIDC_AUDIENCES;

    if (options.jwksOverride) {
      this.#jwks = options.jwksOverride;
    } else {
      const jwksUrl = new URL(options.jwksUri || `${this.issuer}/jwks`);
      this.#jwks = createRemoteJWKSet(jwksUrl, {
        cooldownDuration: 30000,
        cacheMaxAge: 600000
      });
    }
  }

  async verify(token: string): Promise<OidcUser> {
    if (!token || typeof token !== "string") {
      throw new OidcAuthError("Missing or invalid Bearer token");
    }

    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.#jwks, {
        issuer: this.issuer,
        audience: this.audiences
      });
      payload = result.payload;
    } catch (err: unknown) {
      // If audience check failed because token was issued for client_id rather than aud claim
      try {
        const fallback = await jwtVerify(token, this.#jwks, {
          issuer: this.issuer
        });
        const p = fallback.payload;
        const tokenClient = (p["client_id"] as string | undefined) || (p["azp"] as string | undefined);
        const tokenAud = Array.isArray(p.aud) ? p.aud : p.aud ? [p.aud] : [];
        const matchesAud = this.audiences.some((a) => tokenAud.includes(a) || tokenClient === a);
        if (matchesAud || tokenClient === this.clientId) {
          payload = p;
        } else {
          throw err;
        }
      } catch {
        const msg = err instanceof Error ? err.message : "JWT verification failed";
        throw new OidcAuthError(`Tunnus token invalid: ${msg}`);
      }
    }

    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const email = typeof payload["email"] === "string" ? payload["email"] : undefined;
    const name = typeof payload["name"] === "string" ? payload["name"] : undefined;
    const groups = normalizeGroups(payload["groups"]);

    const isAdmin = groups.includes(OIDC_GROUPS.ADMIN);
    const isOperator = isAdmin || groups.includes(OIDC_GROUPS.OPERATOR);
    const isViewer = isOperator || groups.includes(OIDC_GROUPS.VIEWER);
    const canCanva =
      isAdmin ||
      groups.includes(OIDC_GROUPS.CANVA_WRITE) ||
      groups.includes(OIDC_GROUPS.CANVA_OPERATE);

    return {
      sub,
      email,
      name,
      groups,
      isAdmin,
      isOperator,
      isViewer,
      canCanva
    };
  }

  checkPermission(user: OidcUser, request: { method: string; url: string }): void {
    const isRead = ["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase());
    const path = request.url.split("?")[0] || "";

    // If user has none of the authorized church groups
    if (!user.isAdmin && !user.isOperator && !user.isViewer && !user.canCanva) {
      throw new OidcForbiddenError("User is not a member of any authorized picontrol group in Tunnus");
    }

    // Read operations are allowed for viewer, operator, admin and canva
    if (isRead) {
      return;
    }

    // Admin has unrestricted mutating access
    if (user.isAdmin) {
      return;
    }

    // Canva-only operator
    const isCanvaRoute =
      path.startsWith("/api/v1/canva") ||
      path.startsWith("/api/v1/graphics/canva") ||
      path.startsWith("/api/v1/pipgm/items/canva");

    if (user.canCanva && !user.isOperator) {
      if (isCanvaRoute) {
        return;
      }
      throw new OidcForbiddenError("Canva role is only authorized for Canva presentation and graphics operations");
    }

    // Operator has live operations access
    if (user.isOperator) {
      return;
    }

    // Viewer is read-only
    if (user.isViewer) {
      throw new OidcForbiddenError("Viewer role does not have permission to execute mutating control operations");
    }

    throw new OidcForbiddenError("Unauthorized for this operation");
  }
}
