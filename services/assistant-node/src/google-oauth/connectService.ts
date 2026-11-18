// The first-time "Connect Google" flow (authorization-code flow), ported from the .NET
// GoogleAuthController and GoogleOAuthService, with two safety fixes:
//
//  1. `state` is signed and expires. The .NET one was the raw user id, which anyone could forge.
//  2. The browser returns to a page of the web app, and that page posts the code to us with the
//     user's own login token. We only save the tokens if the login token's user is the same user
//     the state was issued to. That stops someone from tricking a victim into finishing the
//     attacker's flow, which would save the victim's Google access under the attacker's account.
import { createHmac } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { GoogleSettings } from "../config.js";
import type { FetchFn } from "../google-mcp/common.js";

export interface ConnectedTokens {
  accessToken: string;
  refreshToken: string;
  scopes: string;
  expiresAt: Date;
}

// Saves (inserts or replaces) the tokens of a user who just connected.
export interface ConnectStore {
  saveConnected(userId: string, tokens: ConnectedTokens): Promise<void>;
}

// The state is missing, forged, expired, or was issued to another user. Safe to show.
export class InvalidStateError extends Error {}

// Google refused or the answer was unusable. The message is safe to show to the user.
export class GoogleConnectError extends Error {}

interface Deps {
  store: ConnectStore;
  settings: GoogleSettings;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: FetchFn;
  now?: () => Date;
}

export function createConnectService(deps: Deps) {
  const fetchFn: FetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const { oauth, urls } = deps.settings;

  // A key derived from the client secret for this one purpose, so no extra secret is needed and
  // the client secret itself is never used to sign anything.
  const stateKey = createHmac("sha256", deps.clientSecret).update("assistant-node:oauth-state").digest();

  async function signState(userId: string): Promise<string> {
    const issuedAt = Math.floor(now().getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + oauth.stateTtlSeconds)
      .sign(stateKey);
  }

  async function checkState(state: string, userId: string): Promise<void> {
    try {
      const { payload } = await jwtVerify(state, stateKey, { algorithms: ["HS256"], currentDate: now() });
      if (payload.sub === userId) return;
    } catch {
      // fall through to the single error below
    }
    throw new InvalidStateError("The sign-in link is invalid or has expired. Please start connecting Google again.");
  }

  return {
    async buildAuthorizationUrl(userId: string): Promise<string> {
      const query = new URLSearchParams({
        client_id: deps.clientId,
        redirect_uri: deps.redirectUri,
        response_type: "code",
        access_type: "offline", // so Google returns a refresh token
        prompt: "consent",      // and returns it again on a reconnect
        scope: oauth.scopes.join(" "),
        state: await signState(userId),
      });
      return `${oauth.authorizationUrl}?${query}`;
    },

    async complete(userId: string, code: string, state: string): Promise<void> {
      await checkState(state, userId);

      const response = await fetchFn(urls.oauthToken, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          redirect_uri: deps.redirectUri,
          grant_type: "authorization_code",
        }),
      });
      // Google's error body is never passed on or logged.
      if (response.status === 400 || response.status === 401) {
        throw new GoogleConnectError("Google did not accept the sign-in. Please try connecting again.");
      }
      if (!response.ok) throw new Error(`Google token request failed with status ${response.status}`);

      const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
      if (!body.access_token || typeof body.expires_in !== "number") throw new Error("Google's token answer was missing fields");
      if (!body.refresh_token) {
        throw new GoogleConnectError(
          "Google did not return a refresh token. Remove TaskTide's access in your Google account settings, then connect again.",
        );
      }

      await deps.store.saveConnected(userId, {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        // What Google actually granted (the user can untick some), not just what we asked for.
        scopes: body.scope ?? oauth.scopes.join(" "),
        expiresAt: new Date(now().getTime() + body.expires_in * 1000),
      });
    },
  };
}

export type ConnectService = ReturnType<typeof createConnectService>;
