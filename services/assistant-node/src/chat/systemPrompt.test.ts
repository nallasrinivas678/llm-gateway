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

  it("says the time zone is unknown when it is not given, and gives the user's own clock when it is", () => {
    expect(prompt).toMatch(/time zone is not known/);
    const local = buildSystemPrompt({
      today: "2026-11-18",
      googleConnected: true,
      local: { timeZone: "America/Los_Angeles", date: "2026-11-17", time: "16:30", offset: "-08:00" },
    });
    expect(local).toContain("America/Los_Angeles");
    expect(local).toContain("2026-11-17 16:30");
    expect(local).toContain("UTC-08:00");
    expect(local).not.toContain("Today's date is");
  });

  it("passes on what the user asked to be remembered, field by field", () => {
    const both = buildSystemPrompt({ today: "d", googleConnected: true, profile: { homeCity: "Oakland", defaultMeetingMinutes: 45 } });
    expect(both).toContain("lives in Oakland; usual meeting length 45 minutes");
    expect(buildSystemPrompt({ today: "d", googleConnected: true, profile: { homeCity: "Oakland" } })).not.toContain("meeting length");
    expect(buildSystemPrompt({ today: "d", googleConnected: true, profile: { homeCity: null, defaultMeetingMinutes: null } })).not.toContain("remember");
  });

  it("only talks about the optional tools that exist", () => {
    for (const word of ["list_documents", "get_weather", "calculate", "save_profile", "Research mode"]) expect(prompt).not.toContain(word);
    const all = buildSystemPrompt({ today: "d", googleConnected: true, documents: true, weather: true, calculator: true, profileTool: true, research: true, webSearch: true });
    for (const word of ["list_documents", "get_weather", "calculate", "save_profile", "Research mode"]) expect(all).toContain(word);
    expect(all).toMatch(/what they asked you to remember\) in a search query/);
  });

  it("tells the model Google is not connected when it is not", () => {
    expect(buildSystemPrompt({ today: "2026-11-18", googleConnected: false })).toMatch(/Google account is not connected/);
  });
});
