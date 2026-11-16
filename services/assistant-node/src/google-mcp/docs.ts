// Google Docs REST calls: read the text of a document and append text to the end of it.
import { googleRequest, InvalidInputError, type FetchFn } from "./common.js";

const DOCS_URL = "https://docs.googleapis.com/v1/documents";
const MAX_CHARS = 20_000;   // keeps one tool result from flooding the model's context

// Document ids are URL path segments; only allow what Google actually uses.
const DOCUMENT_ID = /^[A-Za-z0-9_-]{10,}$/;

export function assertDocumentId(documentId: string): void {
  if (!DOCUMENT_ID.test(documentId)) throw new InvalidInputError("That does not look like a Google Doc id.");
}

interface DocElement {
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
}

export async function readDoc(
  accessToken: string,
  documentId: string,
  fetchFn: FetchFn,
): Promise<{ title: string; text: string; truncated: boolean }> {
  assertDocumentId(documentId);
  const doc = await googleRequest<{ title?: string; body?: { content?: DocElement[] } }>(
    "Docs",
    fetchFn,
    `${DOCS_URL}/${documentId}`,
    accessToken,
  );

  const text = (doc.body?.content ?? [])
    .flatMap((block) => block.paragraph?.elements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("");
  return { title: doc.title ?? "", text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}

// An empty segmentId means the document body; the text goes in just before its final newline.
export async function appendToDoc(
  accessToken: string,
  documentId: string,
  text: string,
  fetchFn: FetchFn,
): Promise<void> {
  assertDocumentId(documentId);
  await googleRequest("Docs", fetchFn, `${DOCS_URL}/${documentId}:batchUpdate`, accessToken, {
    method: "POST",
    body: { requests: [{ insertText: { text, endOfSegmentLocation: {} } }] },
  });
}
