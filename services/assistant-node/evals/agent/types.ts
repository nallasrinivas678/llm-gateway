// What one agent eval scenario looks like: a starting state, what the user says (and decides), and
// what must be true afterwards. Plain data, so a scenario is easy to read and to add.
import type { RunOutcome } from "../../src/chat/runRecord.js";

export interface SeedTask {
  id: string;
  title: string;
  dueDate: string;
  notes?: string;
  priority?: "none" | "low" | "medium" | "high";
  done?: boolean;
}

export interface SeedEmail {
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export interface SeedEvent {
  summary: string;
  start: string;
  end: string;
}

export interface Seed {
  // Defaults to 2026-11-20T12:00:00Z.
  now?: string;
  // False means the user never connected Google: the Google tools are not there.
  googleConnected?: boolean;
  tasks?: SeedTask[];
  emails?: SeedEmail[];
  events?: SeedEvent[];
}

// What the user does, in order: says something, or decides on the Nth change proposed so far
// (counting from 0, across all turns).
export type Step = string | { approve: number } | { reject: number };

// What the scripted model does on one call: say something, or call tools (several at once is allowed).
export type ScriptStep = { say: string } | { call: { name: string; args: Record<string, unknown> }[] };

// A value in `args` is matched loosely so a scenario does not depend on exact wording: a string must
// be contained (ignoring case) in the real value, anything else must be equal.
export type ArgMatch = Record<string, unknown>;

export type Check =
  | { kind: "calledTool"; name: string; args?: ArgMatch }
  | { kind: "notCalledTool"; name: string }
  // A change was proposed (a card was made) for this tool.
  | { kind: "proposed"; tool: string; args?: ArgMatch; previewIncludes?: string }
  | { kind: "pendingCount"; n: number }
  // Nothing real was written: no task created or completed, no Google call that changes anything.
  | { kind: "noChangeMade" }
  | { kind: "changesMade"; n: number }
  // The final reply contains at least one of these (ignoring case).
  | { kind: "replyIncludesAny"; any: string[] }
  | { kind: "replyExcludes"; text: string[] }
  | { kind: "replyAsksQuestion" }
  // What the model sent to a tool must not contain this text (for example the user's private detail).
  | { kind: "toolArgsExclude"; name: string; text: string }
  | { kind: "outcome"; is: RunOutcome; turn?: number }
  // The Nth user decision was refused by the service with this status (for example approving twice).
  | { kind: "decisionRefused"; step: number; status: string };

export type Area = "read" | "write" | "missing-info" | "ambiguous" | "injection" | "limits" | "isolation" | "privacy" | "multi-turn";

export interface Scenario {
  id: string;
  area: Area;
  description: string;
  seed?: Seed;
  steps: Step[];
  // Only for the harness tier: what the scripted model does, call by call.
  script?: ScriptStep[];
  expect: Check[];
}

export interface Trace {
  // The assistant's reply to each message the user sent.
  replies: string[];
  // Every tool call the model made, in order, as saved in the conversation.
  toolCalls: { name: string; args: Record<string, unknown> }[];
  // Every change that was proposed, in order.
  proposals: { id: string; tool: string; args: Record<string, unknown>; preview: string; status: string }[];
  pendingAtEnd: number;
  // Real changes: one line each ("task created: Pay rent", "google POST ...").
  changes: string[];
  // Queries sent to web search.
  searches: string[];
  outcomes: RunOutcome[];
  // Decisions the service refused: [index into steps, status such as "done", "rejected", "expired"].
  refused: { step: number; status: string }[];
  // The chat call failed (timeout, model error) at this step.
  failed: { step: number; message: string }[];
  // How many model calls were made (the model tier's quota).
  modelCalls: number;
}
