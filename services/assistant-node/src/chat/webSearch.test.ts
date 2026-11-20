import { describe, expect, it } from "vitest";
import { createWebSearch, webSearchTool } from "./webSearch.js";

const options = { apiKey: "k", model: "gemini-2.5-flash", timeoutSeconds: 5, maxChars: 50, maxSources: 2 };

const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const grounded = {
  candidates: [
    {
      content: { parts: [{ text: "The release is on " }, { text: "3 March." }] },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://a.example/1", title: "A" } },
          { web: { uri: "https://a.example/1", title: "A again" } },
          { web: { uri: "https://b.example/2" } },
          { web: { uri: "https://c.example/3", title: "C" } },
          {},
        ],
      },
    },
  ],
};

describe("createWebSearch", () => {
  it("asks Gemini with Google Search switched on and returns the answer and distinct sources", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const search = createWebSearch(options, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(grounded));
    }) as unknown as typeof fetch);

    const result = await search("when is the release");

    expect(seen!.url).toContain("/models/gemini-2.5-flash:generateContent");
    expect((seen!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(String(seen!.init.body));
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(JSON.stringify(body)).toContain("when is the release");
    expect(result.answer).toBe("The release is on 3 March.");
    expect(result.sources).toEqual([
      { title: "A", url: "https://a.example/1" },
      { title: "https://b.example/2", url: "https://b.example/2" },
    ]);
  });

  it("cuts a long answer to the limit", async () => {
    const long = { candidates: [{ content: { parts: [{ text: "x".repeat(200) }] } }] };
    expect((await createWebSearch(options, reply(long) as unknown as typeof fetch)("q")).answer).toHaveLength(50);
  });

  it("throws on a failed request, without the response body", async () => {
    const search = createWebSearch(options, reply({ error: "quota for alice" }, 429) as unknown as typeof fetch);
    await expect(search("q")).rejects.toThrow("status 429");
  });
});

describe("webSearchTool", () => {
  it("returns the answer with its sources", async () => {
    const tool = webSearchTool(async () => ({ answer: "It is 3 March.", sources: [{ title: "A", url: "https://a.example" }] }));
    expect(tool.name).toBe("web_search");
    expect(await tool.invoke({ query: "release date" })).toBe("It is 3 March.\n\nSources:\n- A: https://a.example");
  });

  it("says so when nothing was found, and when the search itself fails", async () => {
    expect(await webSearchTool(async () => ({ answer: "", sources: [] })).invoke({ query: "nothing" })).toContain("nothing useful");
    expect(await webSearchTool(async () => ({ answer: "x", sources: [] })).invoke({ query: "no sources" })).toBe("x");
    const failing = webSearchTool(async () => {
      throw new Error("secret detail");
    });
    const text = await failing.invoke({ query: "anything" });
    expect(text).toContain("unavailable");
    expect(text).not.toContain("secret");
  });

  it("refuses a query that is too short or too long", async () => {
    const tool = webSearchTool(async () => ({ answer: "x", sources: [] }));
    await expect(tool.invoke({ query: "a" })).rejects.toThrow();
    await expect(tool.invoke({ query: "q".repeat(301) })).rejects.toThrow();
  });
});
