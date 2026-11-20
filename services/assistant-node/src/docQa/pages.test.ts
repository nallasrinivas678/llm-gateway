import { describe, expect, it } from "vitest";
import { makePdf } from "../resumeMatch/pdf.testutil.js";
import { DocInputError } from "./errors.js";
import { extractPages } from "./pages.js";

const limits = { maxPages: 5, maxPdfBytes: 1_000_000, minTextChars: 20 };
const line = "This is a sentence long enough to count as real text.";

describe("extractPages", () => {
  it("returns the text of each page with its number", async () => {
    const pages = await extractPages(makePdf([[line, "Second line."], ["Page two has its own words, enough to keep."]]), limits);

    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages[0]!.text).toContain("real text");
    expect(pages[1]!.text).toContain("Page two");
  });

  it("rejects an empty, oversized or non-PDF file with a readable message", async () => {
    await expect(extractPages(new Uint8Array(), limits)).rejects.toThrow("empty");
    await expect(extractPages(makePdf([[line]]), { ...limits, maxPdfBytes: 10 })).rejects.toThrow("larger than");
    await expect(extractPages(new TextEncoder().encode("not a pdf at all"), limits)).rejects.toThrow("read as a PDF");
    await expect(extractPages(new TextEncoder().encode("%PDF-1.4 but broken"), limits)).rejects.toBeInstanceOf(DocInputError);
  });

  it("rejects a PDF with too many pages", async () => {
    await expect(extractPages(makePdf(Array.from({ length: 6 }, () => [line])), limits)).rejects.toThrow("6 pages; the limit is 5");
  });

  it("rejects a PDF with almost no text as having no text layer", async () => {
    await expect(extractPages(makePdf([["Hi"]]), limits)).rejects.toThrow("No text layer");
  });
});
