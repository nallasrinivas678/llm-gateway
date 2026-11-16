import { describe, expect, it } from "vitest";
import { loadConfig, loadSettings, parseSettings } from "./config.js";

const issuer = "https://example.supabase.co/auth/v1";
const valid = () => structuredClone(loadSettings());

describe("settings file", () => {
  it("config/default.json is valid and every Google URL is https", () => {
    const { google } = loadSettings();
    expect(Object.values(google.urls).every((url) => url.startsWith("https://"))).toBe(true);
  });

  it("rejects a non-https Google URL", () => {
    const settings = valid();
    settings.google.urls.gmailDrafts = "http://gmail.googleapis.com/drafts";
    expect(() => parseSettings(settings)).toThrow(/https/);
  });

  it("rejects a default that is bigger than its maximum", () => {
    const settings = valid();
    settings.google.limits.calendar.defaultEvents = settings.google.limits.calendar.maxEvents + 1;
    expect(() => parseSettings(settings)).toThrow(/defaultEvents/);
  });

  it("rejects a zero or negative limit", () => {
    const settings = valid();
    settings.google.limits.docs.maxReadChars = 0;
    expect(() => parseSettings(settings)).toThrow();
  });

  it("rejects a missing section", () => {
    const { google: _google, ...rest } = valid();
    expect(() => parseSettings(rest)).toThrow();
  });

  it("explains which file could not be read", () => {
    expect(() => loadSettings(new URL("file:///does/not/exist.json"))).toThrow(/Cannot read settings file/);
  });
});

describe("loadConfig", () => {
  it("falls back to the file for port and CORS origins", () => {
    const config = loadConfig({ SUPABASE_JWT_ISSUER: issuer });
    expect(config.PORT).toBe(loadSettings().server.port);
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(loadSettings().cors.allowedOrigins);
  });

  it("lets environment variables win over the file", () => {
    const config = loadConfig({
      SUPABASE_JWT_ISSUER: issuer,
      PORT: "9000",
      CORS_ALLOWED_ORIGINS: "https://tasktide.app, https://www.tasktide.app",
    });
    expect(config.PORT).toBe(9000);
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(["https://tasktide.app", "https://www.tasktide.app"]);
  });

  it("treats an empty CORS variable as not set", () => {
    const config = loadConfig({ SUPABASE_JWT_ISSUER: issuer, CORS_ALLOWED_ORIGINS: " , " });
    expect(config.CORS_ALLOWED_ORIGINS).toEqual(loadSettings().cors.allowedOrigins);
  });

  it("fails fast when the issuer is missing or not a URL", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ SUPABASE_JWT_ISSUER: "not-a-url" })).toThrow();
  });

  it("treats a blank port (PORT= in a .env file) as not set", () => {
    expect(loadConfig({ SUPABASE_JWT_ISSUER: issuer, PORT: "" }).PORT).toBe(loadSettings().server.port);
  });

  it("accepts a postgres URL for SUPABASE_DB_URL", () => {
    const url = "postgresql://assistant_tokens.abcdefghijklmnopqrst:pw@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
    expect(loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_DB_URL: url }).SUPABASE_DB_URL).toBe(url);
  });

  it("rejects the .NET Key=Value connection string with a helpful message", () => {
    const dotnet = "Host=aws-0-us-west-2.pooler.supabase.com;Port=6543;Username=u;Password=p;Database=postgres";
    expect(() => loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_DB_URL: dotnet })).toThrow(/URL like postgresql/);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ SUPABASE_JWT_ISSUER: issuer, PORT: "abc" })).toThrow();
  });
});
