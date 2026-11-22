import { describe, expect, it } from "vitest";
import { localTime, validTimeZone } from "./localTime.js";

describe("validTimeZone", () => {
  it("accepts real IANA names", () => {
    expect(validTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(validTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("ignores missing, unknown and oversized names", () => {
    expect(validTimeZone(undefined)).toBeUndefined();
    expect(validTimeZone("")).toBeUndefined();
    expect(validTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(validTimeZone("A".repeat(65))).toBeUndefined();
  });
});

describe("localTime", () => {
  it("gives the wall clock and offset in winter and summer (daylight saving)", () => {
    const winter = localTime(new Date("2026-11-21T22:05:00Z"), "America/Los_Angeles");
    expect(winter).toEqual({ timeZone: "America/Los_Angeles", date: "2026-11-21", time: "14:05", offset: "-08:00" });
    const summer = localTime(new Date("2026-07-01T19:00:00Z"), "America/Los_Angeles");
    expect(summer).toMatchObject({ date: "2026-07-01", time: "12:00", offset: "-07:00" });
  });

  it("uses the user's date, which can differ from the UTC date", () => {
    // 03:30 UTC on the 22nd is still the evening of the 21st in California, and the 22nd in Delhi.
    const now = new Date("2026-11-22T03:30:00Z");
    expect(localTime(now, "America/Los_Angeles")).toMatchObject({ date: "2026-11-21", time: "19:30" });
    expect(localTime(now, "Asia/Kolkata")).toMatchObject({ date: "2026-11-22", time: "09:00", offset: "+05:30" });
  });

  it("writes UTC as +00:00 and midnight as 00:00", () => {
    expect(localTime(new Date("2026-11-21T00:00:00Z"), "UTC")).toMatchObject({ time: "00:00", offset: "+00:00" });
  });
});
