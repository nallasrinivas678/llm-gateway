import { describe, expect, it } from "vitest";
import { extractPages } from "../../src/docQa/pages.js";
import { makePdf } from "../../src/resumeMatch/pdf.testutil.js";
import { containsFact } from "../score.js";
import { datasets } from "./index.js";

// Catches a wrong gold answer before it is blamed on the model.
describe.each(datasets)("dataset $name", (dataset) => {
  it("reads back through the real PDF extraction, page by page", async () => {
    const pages = await extractPages(makePdf(dataset.pages), { maxPages: 200, maxPdfBytes: 20 * 1024 * 1024, minTextChars: 1 });
    expect(pages.map((p) => p.page)).toEqual(dataset.pages.map((_, i) => i + 1));
  });

  it("has unique question ids, and at least two unanswerable questions", () => {
    const ids = dataset.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(dataset.questions.filter((q) => q.type === "unanswerable").length).toBeGreaterThanOrEqual(2);
  });

  it("points every answerable question at existing pages that hold the required facts", () => {
    const pageText = dataset.pages.map((lines) => lines.join("\n"));
    for (const q of dataset.questions) {
      if (q.type === "unanswerable") {
        expect(q.goldPages, q.id).toEqual([]);
        expect(q.mustInclude, q.id).toEqual([]);
        continue;
      }
      expect(q.goldPages.length, q.id).toBeGreaterThan(0);
      expect(q.mustInclude.length, q.id).toBeGreaterThan(0);
      for (const page of q.goldPages) expect(page >= 1 && page <= pageText.length, `${q.id}: page ${page}`).toBe(true);
      if (q.derived) continue;
      const goldText = q.goldPages.map((page) => pageText[page - 1]).join("\n");
      for (const entry of q.mustInclude) {
        expect(entry.split("|").some((alternative) => containsFact(goldText, alternative)), `${q.id}: "${entry}" is not on page(s) ${q.goldPages.join(",")}`).toBe(true);
      }
    }
  });
});

describe("all datasets", () => {
  it("have globally unique question ids, a multi-page, an injection and a table question", () => {
    const all = datasets.flatMap((d) => d.questions);
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
    for (const type of ["multi-page", "injection", "table-or-number"] as const) expect(all.some((q) => q.type === type), type).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(30);
  });
});
