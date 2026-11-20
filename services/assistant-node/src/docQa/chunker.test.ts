import { describe, expect, it } from "vitest";
import { chunkPage } from "./chunker.js";

describe("chunkPage", () => {
  it("makes one chunk with the page for short text", () => {
    expect(chunkPage(7, "Hello world.")).toEqual([{ page: 7, content: "Hello world." }]);
  });

  it("makes no chunks for empty or whitespace text", () => {
    expect(chunkPage(1, "   \n  ")).toEqual([]);
  });

  it("splits long text within the limit, keeping whole words and an overlap", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`);
    const chunks = chunkPage(3, words.join(" "), 500, 100);
    const known = new Set(words);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.page).toBe(3);
      expect(chunk.content.length).toBeLessThanOrEqual(500);
      expect(chunk.content.split(" ").every((w) => known.has(w))).toBe(true);
    }
    for (let i = 1; i < chunks.length; i++) {
      const lastWord = chunks[i - 1]!.content.split(" ").at(-1)!;
      expect(chunks[i]!.content).toContain(lastWord);
    }
    expect(chunks[0]!.content.split(" ")[0]).toBe(words[0]);
    expect(chunks.at(-1)!.content.split(" ").at(-1)).toBe(words.at(-1));
  });

  it("cuts a long unbroken string at the limit instead of looping forever", () => {
    const chunks = chunkPage(1, "x".repeat(1200), 500, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.content.length <= 500)).toBe(true);
  });

  it("uses the defaults of 2400 characters", () => {
    const text = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkPage(1, text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 2400)).toBe(true);
  });
});
