// Text of each page of an uploaded PDF, with its page number, so answers can cite pages.
import { extractText, getDocumentProxy } from "unpdf";
import { stripHiddenChars } from "../resumeMatch/cleanText.js";
import { tidyText } from "../resumeMatch/pdfText.js";
import { DocInputError } from "./errors.js";

export interface PageText {
  page: number;
  text: string;
}

export interface PageLimits {
  maxPages: number;
  maxPdfBytes: number;
  minTextChars: number;
}

export async function extractPages(bytes: Uint8Array, limits: PageLimits): Promise<PageText[]> {
  if (bytes.length === 0) throw new DocInputError("The uploaded file is empty.");
  if (bytes.length > limits.maxPdfBytes) throw new DocInputError(`The file is larger than ${Math.round(limits.maxPdfBytes / 1024 / 1024)} MB.`);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== "%PDF") throw new DocInputError("This file couldn't be read as a PDF.");

  let texts: string[];
  try {
    // The parser takes ownership of the buffer it is given, so pass a copy.
    const doc = await getDocumentProxy(new Uint8Array(bytes));
    if (doc.numPages > limits.maxPages) throw new DocInputError(`This PDF has ${doc.numPages} pages; the limit is ${limits.maxPages}.`);
    texts = (await extractText(doc, { mergePages: false })).text;
  } catch (error) {
    if (error instanceof DocInputError) throw error;
    throw new DocInputError("This file couldn't be read as a PDF.");
  }

  const pages = texts.map((text, index) => ({ page: index + 1, text: tidyText(stripHiddenChars(text)) }));
  if (pages.reduce((total, p) => total + p.text.length, 0) < limits.minTextChars) {
    throw new DocInputError("No text layer found; OCR is not supported yet.");
  }
  return pages;
}
