import { describe, expect, it } from "vitest";
import { loadSettings } from "../config.js";
import type { FetchFn } from "../google-mcp/common.js";
import { createTokenService, GoogleReconnectRequired, type StoredTokens, type TokenStore } from "./tokenService.js";

const settings = loadSettings().google;
const NOW = new Date("2026-11-17T12:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

function fakeStore(initial: Record<string, StoredTokens>) {
  const rows = new Map(Object.entries(initial));
  const saves: { userId: string; accessToken: string; expiresAt: Date; newRefreshToken?: string }[] = [];
  const store: TokenStore = {
    get: async (userId) => rows.get(userId) ?? null,
    saveRefreshed: async (userId, accessToken, expiresAt, newRefreshToken) => {
      saves.push({ userId, accessToken, expiresAt, newRefreshToken });
      const old = rows.get(userId)!;
      rows.set(userId, { accessToken, expiresAt, refreshToken: newRefreshToken ?? old.refreshToken });
    },
  };
  return { store, saves, rows };
}

function fakeGoogle(status: number, body: unknown) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as URLSearchParams });
    return new Response(JSON.stringify(body), { status });
  }) as FetchFn;
  return { calls, fetchFn };
}

const service = (store: TokenStore, fetchFn: FetchFn) =>
  createTokenService({ store, settings, clientId: "client-id", clientSecret: "client-secret", fetch: fetchFn, now: () => NOW });

const tokens = (expiresInMinutes: number, extra: Partial<StoredTokens> = {}): StoredTokens => ({
  accessToken: "old-access",
  refreshToken: "refresh-1",
  expiresAt: minutes(expiresInMinutes),
  ...extra,
});

describe("google token service", () => {
  it("returns the stored token without calling Google while it is still valid", async () => {
    const { store } = fakeStore({ u1: tokens(30) });
    const google = fakeGoogle(200, {});

    expect(await service(store, google.fetchFn).getAccessToken("u1")).toBe("old-access");
    expect(google.calls).toHaveLength(0);
  });

  it("refreshes a token that expires within the margin", async () => {
    const { store, saves } = fakeStore({ u1: tokens(0.5) });   // 30 s left, margin is 60 s
    const google = fakeGoogle(200, { access_token: "new-access", expires_in: 3600 });

    expect(await service(store, google.fetchFn).getAccessToken("u1")).toBe("new-access");

    expect(google.calls[0]?.url).toBe(settings.urls.oauthToken);
    expect(Object.fromEntries(google.calls[0]!.body)).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-1",
      grant_type: "refresh_token",
    });
    expect(saves).toHaveLength(1);
    expect(saves[0]?.expiresAt).toEqual(minutes(60));
  });

  it("keeps the old refresh token when Google does not send a new one", async () => {
    const { store, saves, rows } = fakeStore({ u1: tokens(-5) });
    await service(store, fakeGoogle(200, { access_token: "n", expires_in: 3600 }).fetchFn).getAccessToken("u1");

    expect(saves[0]?.newRefreshToken).toBeUndefined();
    expect(rows.get("u1")?.refreshToken).toBe("refresh-1");
  });

  it("stores a new refresh token when Google sends one", async () => {
    const { store, rows } = fakeStore({ u1: tokens(-5) });
    await service(store, fakeGoogle(200, { access_token: "n", expires_in: 3600, refresh_token: "refresh-2" }).fetchFn).getAccessToken("u1");

    expect(rows.get("u1")?.refreshToken).toBe("refresh-2");
  });

  it("asks the user to reconnect when they have never connected Google", async () => {
    const { store } = fakeStore({});
    await expect(service(store, fakeGoogle(200, {}).fetchFn).getAccessToken("nobody")).rejects.toBeInstanceOf(GoogleReconnectRequired);
  });

  it("asks the user to reconnect when Google says access was revoked, without leaking the response", async () => {
    const { store, saves } = fakeStore({ u1: tokens(-5) });
    const google = fakeGoogle(400, { error: "invalid_grant", error_description: "secret-detail" });

    const error = await service(store, google.fetchFn).getAccessToken("u1").catch((e: Error) => e);

    expect(error).toBeInstanceOf(GoogleReconnectRequired);
    expect((error as Error).message).not.toContain("secret-detail");
    expect(saves).toHaveLength(0);
  });

  it("treats a Google server error as a plain failure, not a reconnect", async () => {
    const { store } = fakeStore({ u1: tokens(-5) });
    const error = await service(store, fakeGoogle(503, {}).fetchFn).getAccessToken("u1").catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GoogleReconnectRequired);
  });

  it("rejects an unexpected refresh response", async () => {
    const { store, saves } = fakeStore({ u1: tokens(-5) });
    await expect(service(store, fakeGoogle(200, { nothing: true }).fetchFn).getAccessToken("u1")).rejects.toThrow(/unexpected/);
    expect(saves).toHaveLength(0);
  });

  it("shares one refresh between simultaneous requests for the same user", async () => {
    const { store, saves } = fakeStore({ u1: tokens(-5) });
    const google = fakeGoogle(200, { access_token: "new-access", expires_in: 3600 });
    const tokenService = service(store, google.fetchFn);

    const results = await Promise.all([tokenService.getAccessToken("u1"), tokenService.getAccessToken("u1"), tokenService.getAccessToken("u1")]);

    expect(results).toEqual(["new-access", "new-access", "new-access"]);
    expect(google.calls).toHaveLength(1);
    expect(saves).toHaveLength(1);
  });

  it("never mixes up two users", async () => {
    const { store } = fakeStore({ a: tokens(30, { accessToken: "token-a" }), b: tokens(30, { accessToken: "token-b" }) });
    const tokenService = service(store, fakeGoogle(200, {}).fetchFn);

    expect(await tokenService.getAccessToken("a")).toBe("token-a");
    expect(await tokenService.getAccessToken("b")).toBe("token-b");
  });
});
