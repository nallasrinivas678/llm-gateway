// Plays one scenario through the real chat service (the real agent, tools, approval and run record)
// on the fake backend, and returns a trace of what happened for the scorer to check.
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ActionNotPendingError } from "../../src/chat/approval.js";
import { createChatService } from "../../src/chat/chatService.js";
import { loadSettings } from "../../src/config.js";
import { GoogleReconnectRequired } from "../../src/google-tokens/tokenService.js";
import { isQuotaError } from "../../src/resumeMatch/generate.js";
import { createBackend, EVAL_USER } from "./backend.js";
import type { Scenario, Trace } from "./types.js";

const settings = loadSettings();
const DEFAULT_NOW = "2026-11-20T12:00:00Z";

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runScenario(scenario: Scenario, model: BaseChatModel): Promise<Trace> {
  const backend = createBackend(scenario.seed);
  const service = createChatService({
    model,
    settings,
    getGoogleToken: async () => {
      if (scenario.seed?.googleConnected === false) throw new GoogleReconnectRequired("connect");
      return "eval-google-token";
    },
    openStore: () => backend.conversationStore,
    openTasks: () => backend.taskStore,
    openActions: () => backend.actionStore,
    openRuns: () => backend.runStore,
    googleFetch: backend.googleFetch,
    webSearch: backend.webSearch,
    now: () => new Date(scenario.seed?.now ?? DEFAULT_NOW),
  });

  const trace: Trace = { replies: [], toolCalls: [], proposals: [], pendingAtEnd: 0, changes: [], searches: [], outcomes: [], refused: [], failed: [], modelCalls: 0 };
  let conversationId: string | undefined;
  const proposed: string[] = []; // action ids in the order they were proposed

  for (const [step, action] of scenario.steps.entries()) {
    if (typeof action === "string") {
      try {
        const result = await service.chat({ userId: EVAL_USER, jwt: "eval-jwt", conversationId, message: action });
        conversationId = result.conversationId;
        trace.replies.push(result.reply);
        for (const card of result.pendingActions) proposed.push(card.id);
      } catch (error) {
        // A quota error ends the whole run; anything else is part of the scenario's result.
        if (isQuotaError(error)) throw error;
        trace.failed.push({ step, message: error instanceof Error ? error.name : "error" });
      }
      continue;
    }
    const index = "approve" in action ? action.approve : action.reject;
    const id = proposed[index];
    if (!id) {
      trace.failed.push({ step, message: `no change number ${index} was proposed` });
      continue;
    }
    try {
      await ("approve" in action ? service.approve : service.reject)(EVAL_USER, "eval-jwt", id);
    } catch (error) {
      if (!(error instanceof ActionNotPendingError)) throw error;
      trace.refused.push({ step, status: error.status });
    }
  }

  for (const rows of backend.conversations.values()) {
    for (const message of rows) {
      for (const call of message.toolCalls ?? []) trace.toolCalls.push({ name: call.ToolName, args: parseArgs(call.ArgumentsJson) });
    }
  }
  trace.proposals = [...backend.actions.values()].map((a) => ({ id: a.id, tool: a.tool, args: a.args, preview: a.preview, status: a.status }));
  trace.pendingAtEnd = trace.proposals.filter((p) => p.status === "pending").length;
  trace.changes = backend.changes;
  trace.searches = backend.searches;
  trace.outcomes = backend.runs.map((r) => r.outcome);
  trace.modelCalls = backend.runs.reduce((total, r) => total + r.steps, 0);
  return trace;
}
