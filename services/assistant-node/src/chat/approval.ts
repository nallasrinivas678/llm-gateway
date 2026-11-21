// Approval before the assistant changes anything. A write tool does not run when the model calls
// it: it saves a pending action and tells the model it is waiting for the user. Approving runs the
// stored arguments through the real tool (see chatService.approve).
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { PendingAction } from "./actionStore.js";

// Every tool that changes something. Email stays draft-only, so create_draft is the only mail tool.
export const WRITE_TOOLS = new Set(["create_task", "complete_task", "create_event", "create_draft", "append_to_doc"]);

const FAILURE_PREFIXES = ["The tool call failed", "The task tool failed", "The web search failed", "No task with that id"];

// The tools answer in text (so the model can read it), so a failure is told from its wording.
export const isFailureText = (text: string): boolean => FAILURE_PREFIXES.some((prefix) => text.startsWith(prefix));

const str = (value: unknown, max = 80): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max).trimEnd()}...` : text;
};

// Plain words for the approval card. Built from the arguments only, so what the user reads is what runs.
// `taskTitle` is the title of the task a complete_task call names, when it exists.
export function previewFor(tool: string, args: Record<string, unknown>, taskTitle?: string): string {
  switch (tool) {
    case "create_task": {
      const priority = args.priority && args.priority !== "none" ? `, ${str(args.priority)} priority` : "";
      return `Add the task "${str(args.title)}" due ${str(args.dueDate)}${priority}`;
    }
    case "complete_task":
      return `Mark the task "${taskTitle ?? "(unknown)"}" done${args.occurrenceDate ? ` for ${str(args.occurrenceDate)}` : ""}`;
    case "create_event":
      return `Add the calendar event "${str(args.summary)}" from ${str(args.start)} to ${str(args.end)}`;
    case "create_draft":
      return `Save an email draft to ${str(args.to)}, subject "${str(args.subject)}" (it is not sent)`;
    case "append_to_doc":
      return `Add to the end of a Google Doc: "${str(args.text, 120)}"`;
    default:
      return `Run ${tool}`;
  }
}

const QUEUED =
  "This change is waiting for the user's approval; it has NOT been made yet. Tell the user what you proposed and that they need to approve it on the card below your reply. Do not say it is done.";

export interface ApprovalHooks {
  // Describes the call for the card, or returns text for the model when it cannot be proposed (for
  // example a task that does not exist).
  describe(tool: string, args: Record<string, unknown>): Promise<{ preview: string } | { refusal: string }>;
  propose(tool: string, args: Record<string, unknown>, preview: string): Promise<PendingAction>;
  // Called with each action that was proposed, so the reply can carry the cards.
  onProposed(action: PendingAction): void;
}

// The same tool (name, description, schema), but a write one only proposes.
export function withApproval(tools: DynamicStructuredTool[], hooks: ApprovalHooks): DynamicStructuredTool[] {
  return tools.map((tool) => {
    if (!WRITE_TOOLS.has(tool.name)) return tool;
    return new DynamicStructuredTool({
      name: tool.name,
      description: tool.description,
      schema: tool.schema as Record<string, unknown>,
      func: async (args: unknown) => {
        const input = (args ?? {}) as Record<string, unknown>;
        try {
          const described = await hooks.describe(tool.name, input);
          if ("refusal" in described) return described.refusal;
          hooks.onProposed(await hooks.propose(tool.name, input, described.preview));
          return QUEUED;
        } catch {
          // The error text can come from the database; the model gets a plain sentence.
          return "The change could not be saved for approval. Tell the user it did not go through and to try again.";
        }
      },
    });
  });
}

// The action does not exist or is not the caller's (the two look the same on purpose).
export class ActionNotFoundError extends Error {
  constructor() {
    super("Action not found");
  }
}

// Already decided, running, or past its day.
export class ActionNotPendingError extends Error {
  constructor(readonly status: string) {
    super(`Action is ${status}`);
  }
}
