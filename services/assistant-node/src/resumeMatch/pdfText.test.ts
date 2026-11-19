import { describe, expect, it } from "vitest";
import { ResumeInputError } from "./errors.js";
import { extractPdfText, tidyText } from "./pdfText.js";
import { makePdf } from "./pdf.testutil.js";

const limits = { maxPdfBytes: 1024 * 1024, maxPdfPages: 3, minResumeChars: 40, maxResumeChars: 5000 };
const resumeLines = ["Jane Doe - Senior Engineer", "7 years building C# services at Fabrikam", "Built ASP.NET Core APIs (2M requests/day)"];

describe("extractPdfText", () => {
  it("returns the text of every page", async () => {
    const text = await extractPdfText(makePdf([resumeLines, ["Skills: C#, Docker, PostgreSQL"]]), limits);
    expect(text).toContain("7 years building C# services at Fabrikam");
    expect(text).toContain("ASP.NET Core APIs (2M requests/day)");
    expect(text).toContain("Skills: C#, Docker, PostgreSQL");
  });

  it("refuses an empty file, a file that is not a PDF, and a file over the size limit", async () => {
    await expect(extractPdfText(new Uint8Array(), limits)).rejects.toThrow("empty");
    await expect(extractPdfText(new TextEncoder().encode("hello, not a pdf at all"), limits)).rejects.toThrow("not a PDF");
    await expect(extractPdfText(new Uint8Array(limits.maxPdfBytes + 1).fill(37), limits)).rejects.toThrow("larger than");
  });

  it("refuses a damaged PDF with a readable message", async () => {
    const error = await extractPdfText(new TextEncoder().encode("%PDF-1.4\nthis is not really a pdf"), limits).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumeInputError);
    expect((error as Error).message).toContain("could not be read");
  });

  it("refuses too many pages", async () => {
    await expect(extractPdfText(makePdf([resumeLines, resumeLines, resumeLines, resumeLines]), limits)).rejects.toThrow("at most 3");
  });

  it("explains a PDF with no text layer (a scan)", async () => {
    await expect(extractPdfText(makePdf([[]]), limits)).rejects.toThrow("scanned image");
  });

  it("refuses text over the length limit", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i} ${"x".repeat(80)}`);
    await expect(extractPdfText(makePdf([long]), { ...limits, maxResumeChars: 500 })).rejects.toThrow("longer than 500");
  });
});

describe("tidyText", () => {
  it("collapses spaces and blank lines but keeps line structure", () => {
    expect(tidyText("  a \t b \r\n\r\n\r\n\nc  d  ")).toBe("a b\n\nc d");
  });
});
