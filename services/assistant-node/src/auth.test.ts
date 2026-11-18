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

  const whoami = (authorization: string) => app.request("/assistant/whoami", { headers: { authorization } });

  it("rejects an authorization header that is not a Bearer token", async () => {
    expect((await whoami(`Basic ${await sign({ sub: "u1" })}`)).status).toBe(401);
  });

  it("rejects a token that has no user id", async () => {
    expect((await whoami(`Bearer ${await sign({})}`)).status).toBe(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuer(issuer)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("another-secret-another-secret-another-1"));
    expect((await whoami(`Bearer ${forged}`)).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuer(issuer)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(secret));
    expect((await whoami(`Bearer ${expired}`)).status).toBe(401);
  });

  it("rejects garbage in place of a token", async () => {
    expect((await whoami("Bearer not.a.jwt")).status).toBe(401);
  });
});
