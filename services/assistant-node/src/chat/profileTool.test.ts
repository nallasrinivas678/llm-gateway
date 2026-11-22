import { describe, expect, it, vi } from "vitest";
import { createSupabaseProfileStore, describePatch, profileProblem, profileTool, toPatch, type ProfileStore } from "./profileTool.js";

describe("profileProblem", () => {
  it("accepts a real change", () => {
    expect(profileProblem({ homeCity: "San Jose, CA", defaultMeetingMinutes: 30, timeZone: "America/Los_Angeles" })).toBeNull();
    expect(profileProblem({ homeCity: null })).toBeNull();
  });

  it("refuses an empty change, a bad length, a bad zone and a long city, naming the field", () => {
    expect(profileProblem({})).toBe("nothing to save");
    expect(profileProblem({ defaultMeetingMinutes: 2 })).toContain("defaultMeetingMinutes");
    expect(profileProblem({ defaultMeetingMinutes: 30.5 })).toContain("defaultMeetingMinutes");
    expect(profileProblem({ timeZone: "Mars/Base" })).toBe("timeZone: not a known time zone name");
    expect(profileProblem({ homeCity: "x".repeat(81) })).toContain("homeCity");
  });

  it("does not repeat the value in the problem", () => {
    expect(profileProblem({ timeZone: "Mars/SecretBase" })).not.toContain("Secret");
  });
});

describe("toPatch and describePatch", () => {
  it("keeps only the fields that were given, null included", () => {
    expect(toPatch({ homeCity: "Oakland", unrelated: 1 })).toEqual({ homeCity: "Oakland" });
    expect(toPatch({ homeCity: null, timeZone: null, defaultMeetingMinutes: null })).toEqual({ homeCity: null, timeZone: null, defaultMeetingMinutes: null });
  });

  it("describes what will be remembered or forgotten", () => {
    expect(describePatch({ homeCity: "Oakland", defaultMeetingMinutes: 45, timeZone: "America/Los_Angeles" })).toBe(
      "home city Oakland, usual meeting length 45 minutes, time zone America/Los_Angeles",
    );
    expect(describePatch({ homeCity: null, defaultMeetingMinutes: null, timeZone: null })).toBe(
      "forget the home city, forget the usual meeting length, forget the time zone",
    );
  });
});

describe("profileTool", () => {
  const fakeStore = (overrides: Partial<ProfileStore> = {}): ProfileStore => ({
    get: vi.fn(async () => null),
    save: vi.fn(async () => ({ homeCity: "Oakland", defaultMeetingMinutes: null, timeZone: null })),
    ...overrides,
  });

  it("saves the given fields and says what it saved", async () => {
    const store = fakeStore();
    expect(await profileTool(store).invoke({ homeCity: "Oakland" })).toBe("Saved: home city Oakland.");
    expect(store.save).toHaveBeenCalledWith({ homeCity: "Oakland" });
  });

  it("refuses a change that could not work, without saving", async () => {
    const store = fakeStore();
    expect(await profileTool(store).invoke({ timeZone: "Mars/Base" })).toMatch(/^The tool call failed: timeZone/);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("hides a store failure behind a plain sentence", async () => {
    const tool = profileTool(fakeStore({ save: async () => Promise.reject(new Error("password for db")) }));
    const text = String(await tool.invoke({ homeCity: "Oakland" }));
    expect(text).toBe("The tool call failed: the profile could not be saved.");
  });
});

describe("createSupabaseProfileStore", () => {
  function fakeClient(result: { data: unknown; error: { code?: string } | null }) {
    const calls: unknown[][] = [];
    const chain = {
      select: (...args: unknown[]) => (calls.push(["select", ...args]), chain),
      upsert: (...args: unknown[]) => (calls.push(["upsert", ...args]), chain),
      maybeSingle: () => Promise.resolve(result),
      single: () => Promise.resolve(result),
    };
    return { client: { from: (table: string) => (calls.push(["from", table]), chain) } as never, calls };
  }
  const row = { home_city: "Oakland", default_meeting_minutes: 30, time_zone: null };

  it("reads the caller's own row, or null when there is none", async () => {
    const { client, calls } = fakeClient({ data: row, error: null });
    expect(await createSupabaseProfileStore(client, "u1").get()).toEqual({ homeCity: "Oakland", defaultMeetingMinutes: 30, timeZone: null });
    expect(calls).toContainEqual(["from", "user_profile"]);
    expect(await createSupabaseProfileStore(fakeClient({ data: null, error: null }).client, "u1").get()).toBeNull();
  });

  it("upserts only the given columns for this user", async () => {
    const { client, calls } = fakeClient({ data: row, error: null });
    const now = () => new Date("2026-11-22T10:00:00Z");
    await createSupabaseProfileStore(client, "u1", now).save({ homeCity: "Oakland", timeZone: null });
    expect(calls).toContainEqual(["upsert", { user_id: "u1", updated_at: "2026-11-22T10:00:00.000Z", home_city: "Oakland", time_zone: null }, { onConflict: "user_id" }]);
  });

  it("reports failures with their code and nothing else", async () => {
    const failing = fakeClient({ data: null, error: { code: "42501" } }).client;
    await expect(createSupabaseProfileStore(failing, "u1").get()).rejects.toThrow("Could not read the profile (42501)");
    await expect(createSupabaseProfileStore(failing, "u1").save({ homeCity: "x" })).rejects.toThrow("Could not save the profile (42501)");
  });
});
