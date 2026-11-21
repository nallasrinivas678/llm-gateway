// What a call to a Google tool that changes something must look like, in one place. The tool server
// uses the shapes as its input schemas and the same rules when it runs; the chat uses
// `writeProblem` to refuse a call that could never work BEFORE it is shown to the user as a
// proposal, so a card never ends as "failed" for something that was wrong from the start.
import { z } from "zod";
import type { GoogleSettings } from "../config.js";
import { InvalidInputError } from "./common.js";
import { assertEventTimes } from "./calendar.js";
import { assertDocumentId } from "./docs.js";
import { assertNoLineBreaks } from "./gmail.js";

export function writeShapes(limits: GoogleSettings["limits"]) {
  const { calendar, gmail, docs } = limits;
  return {
    create_event: {
      summary: z.string().min(1).max(calendar.maxSummaryLength),
      start: z.iso.datetime({ offset: true }).describe("ISO 8601 with offset, e.g. 2026-11-20T15:00:00-08:00"),
      end: z.iso.datetime({ offset: true }).describe("ISO 8601 with offset"),
      description: z.string().max(calendar.maxDescriptionLength).optional(),
    },
    create_draft: {
      to: z.email(),
      subject: z.string().min(1).max(gmail.maxSubjectLength),
      body: z.string().min(1).max(gmail.maxBodyLength),
    },
    append_to_doc: {
      documentId: z.string().min(10).max(200),
      text: z.string().min(1).max(docs.maxAppendChars),
    },
  };
}

type WriteTool = keyof ReturnType<typeof writeShapes>;

// The rules that go beyond the shape. They throw InvalidInputError, which the server turns into a
// readable failure.
const RULES: Record<WriteTool, (input: Record<string, string>) => void> = {
  create_event: (input) => assertEventTimes(input.start!, input.end!),
  create_draft: (input) => assertNoLineBreaks(input.to!, input.subject!),
  append_to_doc: (input) => assertDocumentId(input.documentId!),
};

// Why this call to a Google write tool cannot work, in words for the model, or null when it is fine
// (or when the tool is not one of these). Field names only, never the values.
export function writeProblem(tool: string, args: Record<string, unknown>, settings: GoogleSettings): string | null {
  if (!Object.hasOwn(RULES, tool)) return null;
  const name = tool as WriteTool;
  const parsed = z.object(writeShapes(settings.limits)[name]).safeParse(args);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  }
  try {
    RULES[name](parsed.data as Record<string, string>);
    return null;
  } catch (error) {
    if (error instanceof InvalidInputError) return error.message;
    throw error;
  }
}
