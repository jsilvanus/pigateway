import { initUserTokenVerifier } from "@canva/app-middleware";

export interface CanvaUser {
  userId: string;
  /** The Canva team (brand) the user's token was issued for. */
  brandId: string;
}

export interface CanvaUserAuth {
  /** Resolves with the user and team of a valid Canva user token. Rejects for a bad token and for a team that is not allowed. */
  verify(token: string): Promise<CanvaUser>;
}

/** The token is genuine, but its team is not on the allow-list. */
export class CanvaTeamNotAllowed extends Error {
  constructor(public readonly brandId: string) {
    super(`Canva team ${brandId} is not allowed on this gateway`);
    this.name = "CanvaTeamNotAllowed";
  }
}

/**
 * Checks a Canva user token (RS256, keys from Canva's JWKS for this app, audience = the app id) and
 * allows only the listed Canva teams. The plugin sends its user token instead of a shared key, so
 * access is scoped to a user of an allowed team.
 */
export function createCanvaUserAuth(options: { appId: string; allowedBrands: string[] }): CanvaUserAuth {
  if (!options.appId) throw new Error("PIGATEWAY_CANVA_APP_ID is required for Canva user tokens");
  if (options.allowedBrands.length === 0) throw new Error("PIGATEWAY_CANVA_ALLOWED_BRANDS must list at least one Canva team id");
  const verifier = initUserTokenVerifier({ appId: options.appId });
  const allowed = new Set(options.allowedBrands);
  return {
    async verify(token) {
      const { userId, brandId } = await verifier.verify(token);
      if (!allowed.has(brandId)) throw new CanvaTeamNotAllowed(brandId);
      return { userId, brandId };
    },
  };
}
