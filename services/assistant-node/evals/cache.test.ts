import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withDiskCache } from "./cache.js";

describe("withDiskCache", () => {
  it("embeds each text once, keeps the order, and remembers across runs", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "evals-cache-")), "sub", "embeddings.json");
    const embed = vi.fn(async (texts: string[]) => texts.map((t) => [t.length]));

    const first = withDiskCache(embed, file, "m/3");
    expect(await first(["aa", "b", "aa"], "RETRIEVAL_DOCUMENT")).toEqual([[2], [1], [2]]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![0]).toEqual(["aa", "b"]);

    // Same texts again: no new call. A later run reads the saved file.
    await first(["b"], "RETRIEVAL_DOCUMENT");
    expect(embed).toHaveBeenCalledTimes(1);
    const second = withDiskCache(embed, file, "m/3");
    expect(await second(["aa"], "RETRIEVAL_DOCUMENT")).toEqual([[2]]);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(2);
  });

  it("keeps different tasks and models apart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "evals-cache-")), "e.json");
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1]));

    await withDiskCache(embed, file, "m/3")(["x"], "RETRIEVAL_DOCUMENT");
    await withDiskCache(embed, file, "m/3")(["x"], "RETRIEVAL_QUERY");
    await withDiskCache(embed, file, "other/3")(["x"], "RETRIEVAL_DOCUMENT");
    expect(embed).toHaveBeenCalledTimes(3);
  });
});
