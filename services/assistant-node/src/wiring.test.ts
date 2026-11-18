import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { buildServices } from "./wiring.js";

const base = { SUPABASE_JWT_ISSUER: "https://example.supabase.co/auth/v1", SUPABASE_JWT_SECRET: "test-secret-test-secret-test-secret-123" };
const dbAndGoogle = {
  SUPABASE_DB_URL: "postgresql://assistant_tokens.ref:pw@pooler.example.com:6543/postgres",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_API_KEY: "api-key",
};

describe("buildServices", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("builds nothing, and names the missing settings, when nothing is configured", () => {
    expect(buildServices(loadConfig(base))).toEqual({});
    const message = String(warn.mock.calls[0]?.[0]);
    for (const name of ["SUPABASE_DB_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_API_KEY"]) expect(message).toContain(name);
  });

  it("never prints a secret value when it warns", () => {
    buildServices(loadConfig({ ...base, GOOGLE_API_KEY: "super-secret-key" }));
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("super-secret-key");
  });

  it("builds the daily summary without chat when only the public Supabase key is missing", () => {
    const services = buildServices(loadConfig({ ...base, ...dbAndGoogle }));
    expect(services.dailySummary).toBeDefined();
    expect(services.chat).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[0])).toContain("SUPABASE_ANON_KEY");
  });

  it("builds both when everything is set", () => {
    const services = buildServices(loadConfig({ ...base, ...dbAndGoogle, SUPABASE_ANON_KEY: "anon-key" }));
    expect(services.chat).toBeDefined();
    expect(services.dailySummary).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("builds nothing when one of the shared settings is missing", () => {
    const { GOOGLE_API_KEY: _omitted, ...withoutKey } = dbAndGoogle;
    expect(buildServices(loadConfig({ ...base, ...withoutKey, SUPABASE_ANON_KEY: "anon-key" }))).toEqual({});
    expect(String(warn.mock.calls[0]?.[0])).toContain("GOOGLE_API_KEY");
  });
});
