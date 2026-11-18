import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GoogleConnectError, InvalidStateError, type ConnectService } from "./google-oauth/connectService.js";

const secret = "test-secret-test-secret-test-secret-123";
const issuer = "https://example.supabase.co/auth/v1";
const config = loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWT_SECRET: secret });
const userId = "11111111-1111-1111-1111-111111111111";

const token = () =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer(issuer).setExpirationTime("5m").sign(new TextEncoder().encode(secret));

function fakeConnect(failWith?: unknown) {
  const completed: { userId: string; code: string; state: string }[] = [];
  const service = {
    buildAuthorizationUrl: async (user: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=for-${user}`,
    complete: async (user: string, code: string, state: string) => {
      completed.push({ userId: user, code, state });
      if (failWith) throw failWith;
    },
  } as unknown as ConnectService;
  return { service, completed };
}

const send = async (app: ReturnType<typeof createApp>, method: "GET" | "POST", path: string, body?: unknown, withToken = true) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", ...(withToken ? { authorization: `Bearer ${await token()}` } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

describe("GET /auth/google/start", () => {
  it("requires a login token", async () => {
    const { service } = fakeConnect();
    expect((await send(createApp(config, { googleConnect: service }), "GET", "/auth/google/start", undefined, false)).status).toBe(401);
  });

  it("returns the consent URL for the caller, in the .NET field name", async () => {
    const { service } = fakeConnect();
    const response = await send(createApp(config, { googleConnect: service }), "GET", "/auth/google/start");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=for-${userId}` });
  });

  it("answers 503 when connecting is not configured", async () => {
    expect((await send(createApp(config), "GET", "/auth/google/start")).status).toBe(503);
  });
});

describe("POST /auth/google/exchange", () => {
  const body = { code: "the-code", state: "the-state" };

  it("requires a login token", async () => {
    const { service, completed } = fakeConnect();
    expect((await send(createApp(config, { googleConnect: service }), "POST", "/auth/google/exchange", body, false)).status).toBe(401);
    expect(completed).toHaveLength(0);
  });

  it("finishes the connection for the user in the login token, never one named in the body", async () => {
    const { service, completed } = fakeConnect();
    const response = await send(createApp(config, { googleConnect: service }), "POST", "/auth/google/exchange", { ...body, userId: "someone-else" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true });
    expect(completed).toEqual([{ userId, code: "the-code", state: "the-state" }]);
  });

  it.each([
    ["no code", { state: "s" }],
    ["no state", { code: "c" }],
    ["an empty code", { code: "", state: "s" }],
    ["a body that is not JSON", "not json"],
  ])("rejects %s with 400 without calling the service", async (_label, bad) => {
    const { service, completed } = fakeConnect();
    expect((await send(createApp(config, { googleConnect: service }), "POST", "/auth/google/exchange", bad)).status).toBe(400);
    expect(completed).toHaveLength(0);
  });

  it("answers 400 with the reason when the state is not valid", async () => {
    const { service } = fakeConnect(new InvalidStateError("The sign-in link is invalid or has expired."));
    const response = await send(createApp(config, { googleConnect: service }), "POST", "/auth/google/exchange", body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail: "The sign-in link is invalid or has expired." });
  });

  it("answers 502 with the reason when Google refuses", async () => {
    const { service } = fakeConnect(new GoogleConnectError("Google did not accept the sign-in. Please try connecting again."));
    const response = await send(createApp(config, { googleConnect: service }), "POST", "/auth/google/exchange", body);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ detail: "Google did not accept the sign-in. Please try connecting again." });
  });

  it("answers 502 with a generic message and no internal details for other failures", async () => {
    const { service } = fakeConnect(new Error("db password is hunter2"));
    const response = await send(createApp(config, { googleConnect: service }), "POST", "/auth/google/exchange", body);

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });

  it("answers 503 when connecting is not configured", async () => {
    expect((await send(createApp(config), "POST", "/auth/google/exchange", body)).status).toBe(503);
  });

  it("allows the web app's origin to call it (preflight)", async () => {
    const response = await createApp(config).request("/auth/google/exchange", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});
