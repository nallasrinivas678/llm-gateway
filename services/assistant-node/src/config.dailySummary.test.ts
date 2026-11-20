import { describe, expect, it } from "vitest";
import { loadSettings, parseSettings } from "./config.js";

const valid = () => structuredClone(loadSettings());

describe("daily summary settings", () => {
  it("the file has the three .NET email categories, each with a query", () => {
    const { emailQueries } = loadSettings().dailySummary;
    expect(emailQueries.map((q) => q.category)).toEqual(["order", "bill", "travel"]);
    expect(emailQueries.every((q) => q.query.length > 0)).toBe(true);
  });

  it("keeps the .NET defaults: 25 s timeout, 1 retry, 15 minute cache", () => {
    const summary = loadSettings().dailySummary;
    expect(summary).toMatchObject({ llmTimeoutSeconds: 25, llmMaxRetries: 1, cacheTtlSeconds: 900 });
  });

  it("rejects a settings file with no email searches", () => {
    const settings = valid();
    settings.dailySummary.emailQueries = [];
    expect(() => parseSettings(settings)).toThrow();
  });

  it("rejects a search with an empty query", () => {
    const settings = valid();
    settings.dailySummary.emailQueries = [{ category: "order", query: "" }];
    expect(() => parseSettings(settings)).toThrow();
  });

  it.each(["llmTimeoutSeconds", "cacheTtlSeconds", "maxTotalEmails", "maxCalendarEvents", "maxEmailsPerCategory"] as const)(
    "rejects a zero %s",
    (key) => {
      const settings = valid();
      settings.dailySummary[key] = 0;
      expect(() => parseSettings(settings)).toThrow();
    },
  );

  it("treats the thinking budget as optional, allows 0 (off), and rejects a negative number", () => {
    const settings = valid();
    expect(settings.dailySummary.thinkingBudget).toBeUndefined();
    settings.dailySummary.thinkingBudget = 0;
    expect(parseSettings(settings).dailySummary.thinkingBudget).toBe(0);
    settings.dailySummary.thinkingBudget = -1;
    expect(() => parseSettings(settings)).toThrow();
  });

  it("allows zero retries, but not a negative number", () => {
    const settings = valid();
    settings.dailySummary.llmMaxRetries = 0;
    expect(() => parseSettings(settings)).not.toThrow();
    settings.dailySummary.llmMaxRetries = -1;
    expect(() => parseSettings(settings)).toThrow();
  });
});
