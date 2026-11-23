// Gmail REST calls: search (port of the .NET GmailConnector read path) and draft creation.
// There is deliberately no "send": the user reviews and sends a draft from Gmail themselves.
import { googleRequest, InvalidInputError, type GoogleContext } from "./common.js";

export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

interface GmailMessage {
  id: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

export async function searchEmails(ctx: GoogleContext, query: string, maxResults: number): Promise<EmailSummary[]> {
  const messagesUrl = ctx.settings.urls.gmailMessages;
  const search = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const list = await googleRequest<{ messages?: { id: string }[] }>("Gmail", ctx, `${messagesUrl}?${search}`);

  const metadata = "format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date";
  return Promise.all(
    (list.messages ?? []).map(async ({ id }) => {
      const message = await googleRequest<GmailMessage>("Gmail", ctx, `${messagesUrl}/${encodeURIComponent(id)}?${metadata}`);
      const header = (name: string) =>
        message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
      return { id: message.id, subject: header("Subject"), from: header("From"), date: header("Date"), snippet: message.snippet ?? "" };
    }),
  );
}

// One message with its body. Bodies are untrusted text (anyone can send anyone an email), so the
// tool description says so, and the length is cut to keep one email from flooding the context.
export interface EmailBody {
  id: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
  truncated: boolean;
  // File names only; attachments are never opened.
  attachments: string[];
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function assertMessageId(messageId: string): void {
  if (!MESSAGE_ID.test(messageId)) throw new InvalidInputError("That does not look like a Gmail message id. Use an id from search_emails.");
}

const decodeBase64Url = (data: string) => Buffer.from(data, "base64url").toString("utf8");

const NAMED_ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Plain text from an HTML-only email: no scripts or styles, line breaks where blocks end, entities decoded.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity[0] === "#") {
        const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectParts(part: GmailPart, found: { plain: string[]; html: string[]; attachments: string[] }): void {
  // A part with a file name is an attachment, whatever its type.
  if (part.filename) {
    found.attachments.push(part.filename);
    return;
  }
  if (part.mimeType === "text/plain" && part.body?.data) found.plain.push(decodeBase64Url(part.body.data));
  else if (part.mimeType === "text/html" && part.body?.data) found.html.push(decodeBase64Url(part.body.data));
  for (const child of part.parts ?? []) collectParts(child, found);
}

export async function readEmail(ctx: GoogleContext, messageId: string): Promise<EmailBody> {
  assertMessageId(messageId);
  const message = await googleRequest<{ id: string; payload?: GmailPart }>(
    "Gmail",
    ctx,
    `${ctx.settings.urls.gmailMessages}/${encodeURIComponent(messageId)}?format=full`,
  );
  const payload = message.payload ?? {};
  const header = (name: string) => payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const found = { plain: [] as string[], html: [] as string[], attachments: [] as string[] };
  collectParts(payload, found);
  // Prefer the plain-text version; an HTML-only email is turned into text.
  const full = (found.plain.length > 0 ? found.plain.join("\n") : found.html.map(htmlToText).join("\n")).trim();
  const max = ctx.settings.limits.gmail.maxReadChars;
  return {
    id: message.id,
    subject: header("Subject"),
    from: header("From"),
    to: header("To"),
    date: header("Date"),
    body: full.slice(0, max),
    truncated: full.length > max,
    attachments: found.attachments,
  };
}

const toBase64Url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

// Builds a plain-text RFC 2822 message. Line breaks in the address or subject would let a
// caller inject extra headers (for example a hidden Bcc), so they are rejected.
export function assertNoLineBreaks(...values: string[]): void {
  for (const value of values) {
    if (/[\r\n]/.test(value)) throw new InvalidInputError("Line breaks are not allowed in the address or subject.");
  }
}

export function buildRawMessage(input: { to: string; subject: string; body: string }): string {
  assertNoLineBreaks(input.to, input.subject);
  const subject = /^[\x20-\x7e]*$/.test(input.subject)
    ? input.subject
    : `=?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`;

  const lines = [
    `To: ${input.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64"),
  ];
  return toBase64Url(lines.join("\r\n"));
}

export async function createDraft(ctx: GoogleContext, input: { to: string; subject: string; body: string }): Promise<{ draftId: string }> {
  const draft = await googleRequest<{ id: string }>("Gmail", ctx, ctx.settings.urls.gmailDrafts, {
    method: "POST",
    body: { message: { raw: buildRawMessage(input) } },
  });
  return { draftId: draft.id };
}
