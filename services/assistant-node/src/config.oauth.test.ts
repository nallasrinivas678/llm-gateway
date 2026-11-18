import { describe, expect, it } from "vitest";
import { loadConfig, loadSettings, parseSettings } from "./config.js";

const issuer = "https://example.supabase.co/auth/v1";
const valid = () => structuredClone(loadSettings());

describe("Google connect settings", () => {
  it("the file is valid and the consent URL is https", () => {
    expect(loadSettings().google.oauth.authorizationUrl).toMatch(/^https:\/\//);
  });

  it("rejects an empty scope list", () => {
    const settings = valid();
    settings.google.oauth.scopes = [];
    expect(() => parseSettings(settings)).toThrow();
  });

  it("rejects a zero state lifetime", () => {
    const settings = valid();
    settings.google.oauth.stateTtlSeconds = 0;
    expect(() => parseSettings(settings)).toThrow();
  });

  it("reads the redirect address from the environment, and treats a blank one as not set", () => {
    expect(loadConfig({ SUPABASE_JWT_ISSUER: issuer, GOOGLE_REDIRECT_URI: "https://tasktide.app/app/google/callback" }).GOOGLE_REDIRECT_URI).toBe(
      "https://tasktide.app/app/google/callback",
    );
    expect(loadConfig({ SUPABASE_JWT_ISSUER: issuer, GOOGLE_REDIRECT_URI: "" }).GOOGLE_REDIRECT_URI).toBeUndefined();
  });

  it("rejects a redirect address that is not a URL", () => {
    expect(() => loadConfig({ SUPABASE_JWT_ISSUER: issuer, GOOGLE_REDIRECT_URI: "tasktide.app/callback" })).toThrow();
  });
});
