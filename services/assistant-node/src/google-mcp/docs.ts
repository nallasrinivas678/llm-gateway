// Google Docs REST calls: read the text of a document and append text to the end of it.
import { googleRequest, InvalidInputError, type GoogleContext } from "./common.js";

// Document ids are URL path segments; only allow what Google actually uses. This is a safety
// rule, not a setting, so it stays in code.
const DOCUMENT_ID = /^[A-Za-z0-9_-]{10,}$/;

export function assertDocumentId(documentId: string): void {
  if (!DOCUMENT_ID.test(documentId)) throw new InvalidInputError("That does not look like a Google Doc id.");
}

interface DocElement {
  paragraph?: { elements?: { textRun?: { content?: string } }[] };
}

export async function readDoc(
  ctx: GoogleContext,
  documentId: string,
): Promise<{ title: string; text: string; truncated: boolean }> {
  assertDocumentId(documentId);
  const doc = await googleRequest<{ title?: string; body?: { content?: DocElement[] } }>(
    "Docs",
    ctx,
    `${ctx.settings.urls.docsDocuments}/${documentId}`,
  );

  const text = (doc.body?.content ?? [])
    .flatMap((block) => block.paragraph?.elements ?? [])
    .map((element) => element.textRun?.content ?? "")
    .join("");
  const max = ctx.settings.limits.docs.maxReadChars;   // keeps one tool result from flooding the model's context
  return { title: doc.title ?? "", text: text.slice(0, max), truncated: text.length > max };
}

// An empty segmentId means the document body; the text goes in just before its final newline.
export async function appendToDoc(ctx: GoogleContext, documentId: string, text: string): Promise<void> {
  assertDocumentId(documentId);
  await googleRequest("Docs", ctx, `${ctx.settings.urls.docsDocuments}/${documentId}:batchUpdate`, {
    method: "POST",
    body: { requests: [{ insertText: { text, endOfSegmentLocation: {} } }] },
  });
}
