import { SignJWT } from "jose";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../config.js";
import type { FetchFn } from "../google-mcp/common.js";
import { createConnectService, GoogleConnectError, InvalidStateError, type ConnectedTokens } from "./connectService.js";

const settings = loadSettings().google;
const redirectUri = "https://tasktide.app/app/google/callback";
const clientSecret = "client-secret-for-tests";
const start = Date.parse("2026-11-18T10:00:00Z");

function setup(options: { status?: number; body?: unknown; clock?: { time: number } } = {}) {
  const saved: { userId: string; tokens: ConnectedTokens }[] = [];
  const googleCalls: { url: string; form: URLSearchParams }[] = [];
  const clock = options.clock ?? { time: start };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    googleCalls.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
    return new Response(
      JSON.stringify(options.body ?? { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, scope: "granted scopes" }),
      { status: options.status ?? 200 },
    );
  }) as FetchFn;
  const service = createConnectService({
    store: { saveConnected: async (userId, tokens) => void saved.push({ userId, tokens }) },
    settings,
    clientId: "client-id",
    clientSecret,
    redirectUri,
    fetch,
    now: () => new Date(clock.time),
  });
  return { service, saved, googleCalls, clock };
}

// Pulls the state out of the consent URL, the way the web app's callback page gets it back.
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("connect Google: consent URL", () => {
  it("asks Google for offline access, a fresh consent and the configured scopes", async () => {
    const url = new URL(await setup().service.buildAuthorizationUrl("user-1"));

    expect(`${url.origin}${url.pathname}`).toBe(settings.oauth.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(settings.oauth.scopes.join(" "));
  });

  it("asks for what drafts need (gmail.compose) and never for permission to send mail", () => {
    const scopes = settings.oauth.scopes;
    expect(scopes).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(scopes.some((s) => s.endsWith("gmail.send"))).toBe(false);
  });

  it("never puts the client secret in the URL", async () => {
    expect(await setup().service.buildAuthorizationUrl("user-1")).not.toContain(clientSecret);
  });

  it("gives a different state to each user", async () => {
    const { service } = setup();
    expect(stateOf(await service.buildAuthorizationUrl("user-1"))).not.toBe(stateOf(await service.buildAuthorizationUrl("user-2")));
  });
});

describe("connect Google: finishing", () => {
  it("swaps the code for tokens and saves them for that user, with the scopes Google granted", async () => {
    const { service, saved } = setup();
    const state = stateOf(await service.buildAuthorizationUrl("user-1"));

    await service.complete("user-1", "the-code", state);

    expect(saved).toEqual([
      {
        userId: "user-1",
        tokens: { accessToken: "access-1", refreshToken: "refresh-1", scopes: "granted scopes", expiresAt: new Date(start + 3600 * 1000) },
      },
    ]);
  });

  it("sends Google the code, the client credentials and the same redirect URI", async () => {
    const { service, googleCalls } = setup();
    await service.complete("user-1", "the-code", stateOf(await service.buildAuthorizationUrl("user-1")));

    expect(googleCalls).toHaveLength(1);
    expect(googleCalls[0]!.url).toBe(settings.urls.oauthToken);
    expect(Object.fromEntries(googleCalls[0]!.form)).toEqual({
      code: "the-code",
      client_id: "client-id",
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
  });

  it("falls back to the requested scopes when Google does not list the granted ones", async () => {
    const { service, saved } = setup({ body: { access_token: "a", refresh_token: "r", expires_in: 60 } });
    await service.complete("user-1", "c", stateOf(await service.buildAuthorizationUrl("user-1")));
    expect(saved[0]!.tokens.scopes).toBe(settings.oauth.scopes.join(" "));
  });

  it("refuses a state that was issued to another user, and does not call Google", async () => {
    const { service, saved, googleCalls } = setup();
    const victimsState = stateOf(await service.buildAuthorizationUrl("attacker"));

    await expect(service.complete("victim", "code", victimsState)).rejects.toBeInstanceOf(InvalidStateError);
    expect(googleCalls).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it("refuses an expired state", async () => {
    const { service, clock, googleCalls } = setup();
    const state = stateOf(await service.buildAuthorizationUrl("user-1"));
    clock.time += (settings.oauth.stateTtlSeconds + 1) * 1000;

    await expect(service.complete("user-1", "code", state)).rejects.toBeInstanceOf(InvalidStateError);
    expect(googleCalls).toHaveLength(0);
  });

  it("accepts the state right up to its lifetime", async () => {
    const { service, clock, saved } = setup();
    const state = stateOf(await service.buildAuthorizationUrl("user-1"));
    clock.time += (settings.oauth.stateTtlSeconds - 1) * 1000;

    await service.complete("user-1", "code", state);
    expect(saved).toHaveLength(1);
  });

  it.each([
    ["garbage", "not-a-token"],
    ["a plain user id (the old .NET style)", "11111111-1111-1111-1111-111111111111"],
    ["an empty-looking token", "a.b.c"],
  ])("refuses %s as the state", async (_label, state) => {
    const { service, googleCalls } = setup();
    await expect(service.complete("user-1", "code", state)).rejects.toBeInstanceOf(InvalidStateError);
    expect(googleCalls).toHaveLength(0);
  });

  it("refuses a state signed with a different key", async () => {
    const { service, googleCalls } = setup();
    const issuedAt = Math.floor(start / 1000);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 600)
      .sign(createHmac("sha256", "some-other-secret").update("assistant-node:oauth-state").digest());

    await expect(service.complete("user-1", "code", forged)).rejects.toBeInstanceOf(InvalidStateError);
    expect(googleCalls).toHaveLength(0);
  });

  it("tells the user to try again when Google rejects the code, without saving or echoing Google's reply", async () => {
    const { service, saved } = setup({ status: 400, body: { error: "invalid_grant", error_description: "secret detail" } });
    const state = stateOf(await service.buildAuthorizationUrl("user-1"));

    const error = await service.complete("user-1", "bad-code", state).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleConnectError);
    expect((error as Error).message).not.toContain("secret detail");
    expect(saved).toHaveLength(0);
  });

  it("explains what to do when Google sends no refresh token, and saves nothing", async () => {
    const { service, saved } = setup({ body: { access_token: "a", expires_in: 3600 } });
    const state = stateOf(await service.buildAuthorizationUrl("user-1"));

    const error = await service.complete("user-1", "code", state).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleConnectError);
    expect((error as Error).message).toMatch(/refresh token/);
    expect(saved).toHaveLength(0);
  });

  it("treats a Google outage as a plain error (not shown to the user as advice)", async () => {
    const { service, saved } = setup({ status: 503, body: {} });
    const state = stateOf(await service.buildAuthorizationUrl("user-1"));

    const error = await service.complete("user-1", "code", state).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GoogleConnectError);
    expect(error).not.toBeInstanceOf(InvalidStateError);
    expect(saved).toHaveLength(0);
  });

  it("rejects an answer with no access token", async () => {
    const { service, saved } = setup({ body: { refresh_token: "r", expires_in: 3600 } });
    await expect(service.complete("user-1", "code", stateOf(await service.buildAuthorizationUrl("user-1")))).rejects.toThrow();
    expect(saved).toHaveLength(0);
  });
});
