// Gives the rest of the service a valid Google access token for a user, refreshing it when it is
// about to expire. Port of the read-and-refresh half of the .NET GoogleOAuthService
// (GetValidAccessTokenAsync). The first-time connect flow is in src/google-oauth.
import type { GoogleSettings } from "../config.js";
import { fetchWithTimeout, type FetchFn } from "../google-mcp/common.js";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

// Where tokens live. The real one (PgTokenStore) talks to Postgres; tests use an in-memory fake.
export interface TokenStore {
  get(userId: string): Promise<StoredTokens | null>;
  // Keeps the stored refresh token unless Google sent a new one.
  saveRefreshed(userId: string, accessToken: string, expiresAt: Date, newRefreshToken?: string): Promise<void>;
}

// The user has to connect (or reconnect) their Google account. Safe to show to the user.
export class GoogleReconnectRequired extends Error {}

interface Deps {
  store: TokenStore;
  settings: GoogleSettings;
  clientId: string;
  clientSecret: string;
  fetch?: FetchFn;
  now?: () => Date;
}

export function createTokenService(deps: Deps) {
  const fetchFn: FetchFn = deps.fetch ?? fetchWithTimeout(deps.settings.requestTimeoutSeconds);
  const now = deps.now ?? (() => new Date());
  const marginMs = deps.settings.tokens.refreshMarginSeconds * 1000;

  // If two requests for the same user need a refresh at once, they share one refresh call.
  const inFlight = new Map<string, Promise<string>>();

  async function refresh(userId: string, stored: StoredTokens): Promise<string> {
    const response = await fetchFn(deps.settings.urls.oauthToken, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        refresh_token: stored.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      // Google answers 400 invalid_grant when the user revoked access. Anything else is our problem.
      // The response body is never logged or passed on: it can echo request details.
      if (response.status === 400 || response.status === 401) {
        throw new GoogleReconnectRequired("Google access was revoked or expired. Please reconnect your Google account.");
      }
      throw new Error(`Google token refresh failed with status ${response.status}`);
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
    if (!body.access_token || typeof body.expires_in !== "number") {
      throw new Error("Google token refresh returned an unexpected response");
    }

    const expiresAt = new Date(now().getTime() + body.expires_in * 1000);
    await deps.store.saveRefreshed(userId, body.access_token, expiresAt, body.refresh_token);
    return body.access_token;
  }

  return {
    async getAccessToken(userId: string): Promise<string> {
      const stored = await deps.store.get(userId);
      if (!stored) throw new GoogleReconnectRequired("Google account is not connected. Please connect it first.");

      if (stored.expiresAt.getTime() - now().getTime() > marginMs) return stored.accessToken;

      const pending = inFlight.get(userId) ?? refresh(userId, stored).finally(() => inFlight.delete(userId));
      inFlight.set(userId, pending);
      return pending;
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;
