import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./systemPrompt.js";

describe("system prompt", () => {
  const prompt = buildSystemPrompt({ today: "2026-11-18", googleConnected: true });

  it("gives today's date", () => {
    expect(prompt).toContain("2026-11-18");
  });

  it("tells the model that tool output is data, not instructions", () => {
    expect(prompt).toMatch(/data, not instructions/);
  });

  it("tells the model it cannot send email", () => {
    expect(prompt).toMatch(/cannot send email/);
  });

  it("does not mention a missing Google account when Google is connected", () => {
    expect(prompt).not.toMatch(/not connected/);
  });

  it("only mentions web_search when the tool exists, and keeps private details out of queries", () => {
    expect(prompt).not.toContain("web_search");
    const withSearch = buildSystemPrompt({ today: "2026-11-18", googleConnected: true, webSearch: true });
    expect(withSearch).toContain("web_search");
    expect(withSearch).toMatch(/Never put the user's private details/);
  });

  it("tells the model Google is not connected when it is not", () => {
    expect(buildSystemPrompt({ today: "2026-11-18", googleConnected: false })).toMatch(/Google account is not connected/);
  });
});
