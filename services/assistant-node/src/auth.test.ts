import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const secret = "test-secret-test-secret-test-secret-123";
const issuer = "https://example.supabase.co/auth/v1";
const app = createApp(loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWT_SECRET: secret }));

const sign = (claims: { sub?: string; iss?: string }) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub ?? "")
    .setIssuer(claims.iss ?? issuer)
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));

describe("auth", () => {
  it("serves /health without a token", async () => {
    expect((await app.request("/health")).status).toBe(200);
  });

  it("rejects a missing token", async () => {
    expect((await app.request("/assistant/whoami")).status).toBe(401);
  });

  it("rejects a token from another issuer", async () => {
    const token = await sign({ sub: "u1", iss: "https://evil.example/auth/v1" });
    const res = await app.request("/assistant/whoami", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
  });

  it("accepts a valid HS256 token and exposes the user id", async () => {
    const token = await sign({ sub: "11111111-1111-1111-1111-111111111111" });
    const res = await app.request("/assistant/whoami", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "11111111-1111-1111-1111-111111111111" });
  });
});
