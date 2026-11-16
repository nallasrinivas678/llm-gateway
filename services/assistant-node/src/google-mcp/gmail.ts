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

const toBase64Url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

// Builds a plain-text RFC 2822 message. Line breaks in the address or subject would let a
// caller inject extra headers (for example a hidden Bcc), so they are rejected.
export function buildRawMessage(input: { to: string; subject: string; body: string }): string {
  for (const value of [input.to, input.subject]) {
    if (/[\r\n]/.test(value)) throw new InvalidInputError("Line breaks are not allowed in the address or subject.");
  }
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
