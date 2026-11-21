// A record of each chat turn (table agent_runs): how long it took, how many model steps, which
// tools ran and how it ended. It answers "how slow is it", "which tool fails" and "how often does
// it hit the step limit". It holds NO message text and NO tool arguments or results: the
// conversation already has the messages, and personal content stays out of the record.
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFailureText } from "./approval.js";

export type RunOutcome = "ok" | "step_limit" | "timeout" | "error";

export interface RecordedToolCall {
  name: string;
  ms: number;
  ok: boolean;
  // Only when it failed: "timeout", "failed" (the tool answered with a failure) or "error" (it threw).
  code?: "timeout" | "failed" | "error";
}

export interface RunRecord {
  conversationId: string;
  startedAt: string;
  durationMs: number;
  model: string;
  steps: number;
  toolCalls: RecordedToolCall[];
  outcome: RunOutcome;
  actionsProposed: number;
}

export interface RunStore {
  record(run: RunRecord): Promise<void>;
}

export function createSupabaseRunStore(client: SupabaseClient, userId: string): RunStore {
  return {
    async record(run) {
      const { error } = await client.from("agent_runs").insert({
        user_id: userId,
        conversation_id: run.conversationId,
        started_at: run.startedAt,
        duration_ms: Math.max(0, Math.round(run.durationMs)),
        model: run.model,
        steps: run.steps,
        tool_calls: run.toolCalls,
        outcome: run.outcome,
        actions_proposed: run.actionsProposed,
      });
      if (error) throw new Error(`Could not record the run (${error.code ?? "unknown"})`);
    },
  };
}

const TIMED_OUT = /timed? ?out/i;

// The same tools, each timing its own calls into `calls`. Only the name, the time and whether it
// worked are kept; what it was asked and what it answered are not. A tool that answers with a
// failure text is "not ok" even though it did not throw, because that is how the tools report it.
export function withTiming(tools: DynamicStructuredTool[], calls: RecordedToolCall[], clock: () => number = () => performance.now()): DynamicStructuredTool[] {
  return tools.map(
    (tool) =>
      new DynamicStructuredTool({
        name: tool.name,
        description: tool.description,
        schema: tool.schema as Record<string, unknown>,
        func: async (args: unknown) => {
          const started = clock();
          try {
            const answer = await tool.invoke(args);
            const text = typeof answer === "string" ? answer : "";
            const failed = isFailureText(text);
            calls.push({ name: tool.name, ms: Math.round(clock() - started), ok: !failed, ...(failed ? { code: TIMED_OUT.test(text) ? ("timeout" as const) : ("failed" as const) } : {}) });
            return answer;
          } catch (error) {
            calls.push({ name: tool.name, ms: Math.round(clock() - started), ok: false, code: error instanceof Error && TIMED_OUT.test(error.message) ? "timeout" : "error" });
            throw error;
          }
        },
      }),
  );
}

// How a thrown error ended the run: a time limit, or anything else.
export function outcomeOf(error: unknown): RunOutcome {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "error";
}
