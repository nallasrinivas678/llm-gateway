// Pulls the text out of an uploaded resume PDF. Only the text is kept; the file is not stored.
import { extractText, getDocumentProxy } from "unpdf";
import { ResumeInputError } from "./errors.js";

export interface PdfLimits {
  maxPdfBytes: number;
  maxPdfPages: number;
  minResumeChars: number;
  maxResumeChars: number;
}

// One line per text line, no runs of spaces, at most one blank line in a row.
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfText(bytes: Uint8Array, limits: PdfLimits): Promise<string> {
  if (bytes.length === 0) throw new ResumeInputError("The file is empty.");
  if (bytes.length > limits.maxPdfBytes) {
    throw new ResumeInputError(`The file is larger than ${Math.round(limits.maxPdfBytes / 1024 / 1024)} MB.`);
  }
  // Every PDF starts with "%PDF"; checking it first avoids handing other files to the parser.
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "%PDF") throw new ResumeInputError("The file is not a PDF.");

  let pages: string[];
  try {
    // The parser takes ownership of the buffer it is given, so pass a copy.
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    if (doc.numPages > limits.maxPdfPages) {
      throw new ResumeInputError(`The PDF has ${doc.numPages} pages; a resume can have at most ${limits.maxPdfPages}.`);
    }
    pages = (await extractText(doc, { mergePages: false })).text;
  } catch (error) {
    if (error instanceof ResumeInputError) throw error;
    throw new ResumeInputError("The PDF could not be read. It may be damaged or password protected.");
  }

  const text = tidyText(pages.join("\n\n"));
  if (text.length < limits.minResumeChars) {
    throw new ResumeInputError("No readable text was found. The PDF may be a scanned image; export it as text-based PDF or paste the text instead.");
  }
  if (text.length > limits.maxResumeChars) {
    throw new ResumeInputError(`The resume text is longer than ${limits.maxResumeChars} characters.`);
  }
  return text;
}
