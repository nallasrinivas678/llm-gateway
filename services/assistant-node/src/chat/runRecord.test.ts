import { DynamicStructuredTool } from "@langchain/core/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSupabaseRunStore, outcomeOf, withTiming, type RecordedToolCall, type RunRecord } from "./runRecord.js";

const run: RunRecord = {
  conversationId: "c-1",
  startedAt: "2026-11-20T12:00:00.000Z",
  durationMs: 1234.6,
  model: "gemini-2.5-flash",
  steps: 2,
  toolCalls: [{ name: "list_events", ms: 400, ok: true }],
  outcome: "ok",
  actionsProposed: 1,
};

function fakeSupabase(failWith?: string) {
  const inserts: { table: string; row: unknown }[] = [];
  const client = {
    from: (table: string) => ({
      insert: (row: unknown) => {
        inserts.push({ table, row });
        return Promise.resolve({ error: failWith ? { code: failWith } : null });
      },
    }),
  };
  return { client: client as unknown as SupabaseClient, inserts };
}

describe("run store", () => {
  it("saves one row for the caller, with whole milliseconds", async () => {
    const { client, inserts } = fakeSupabase();
    await createSupabaseRunStore(client, "user-1").record(run);

    expect(inserts).toEqual([
      {
        table: "agent_runs",
        row: {
          user_id: "user-1",
          conversation_id: "c-1",
          started_at: "2026-11-20T12:00:00.000Z",
          duration_ms: 1235,
          model: "gemini-2.5-flash",
          steps: 2,
          tool_calls: [{ name: "list_events", ms: 400, ok: true }],
          outcome: "ok",
          actions_proposed: 1,
        },
      },
    ]);
  });

  it("never saves a negative duration", async () => {
    const { client, inserts } = fakeSupabase();
    await createSupabaseRunStore(client, "u").record({ ...run, durationMs: -5 });
    expect((inserts[0]!.row as { duration_ms: number }).duration_ms).toBe(0);
  });

  it("turns a database error into a plain error with only its code", async () => {
    const error = await createSupabaseRunStore(fakeSupabase("42501").client, "u").record(run).catch((e: Error) => e);
    expect((error as Error).message).toBe("Could not record the run (42501)");
  });
});

describe("withTiming", () => {
  const tool = (name: string, func: (args: { q: string }) => Promise<string>) =>
    new DynamicStructuredTool({ name, description: `does ${name}`, schema: z.object({ q: z.string() }), func });
  let ticks = 0;
  const clock = () => (ticks += 50);

  it("keeps the tool as it is and records its name, time and success, never its arguments or answer", async () => {
    const calls: RecordedToolCall[] = [];
    const [timed] = withTiming([tool("list_tasks", async () => "secret answer")], calls, clock);

    expect(timed!.name).toBe("list_tasks");
    expect(timed!.description).toBe("does list_tasks");
    expect(await timed!.invoke({ q: "secret question" })).toBe("secret answer");
    expect(calls).toEqual([{ name: "list_tasks", ms: 50, ok: true }]);
    expect(JSON.stringify(calls)).not.toContain("secret");
  });

  it.each([
    ["The tool call failed: Request timed out", "timeout"],
    ["The tool call failed: Google Calendar request failed (status 500).", "failed"],
    ["The web search failed. Tell the user it is unavailable right now.", "failed"],
    ["No task with that id was found.", "failed"],
  ])("records a failure answer (%s) as not ok, with the code %s", async (answer, code) => {
    const calls: RecordedToolCall[] = [];
    const [timed] = withTiming([tool("t", async () => answer)], calls, clock);
    await timed!.invoke({ q: "x" });
    expect(calls[0]).toMatchObject({ name: "t", ok: false, code });
  });

  it("records a tool that throws, and lets the error through", async () => {
    const calls: RecordedToolCall[] = [];
    const [timed] = withTiming(
      [
        tool("boom", async () => {
          throw new Error("secret detail");
        }),
        tool("slow", async () => {
          throw new Error("Request timed out");
        }),
      ],
      calls,
      clock,
    );
    await expect(timed!.invoke({ q: "x" })).rejects.toThrow();
    await expect(withTiming([tool("slow", async () => Promise.reject(new Error("Request timed out")))], calls, clock)[0]!.invoke({ q: "x" })).rejects.toThrow();
    expect(calls.map((c) => [c.name, c.ok, c.code])).toEqual([
      ["boom", false, "error"],
      ["slow", false, "timeout"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("secret detail");
  });
});

describe("outcomeOf", () => {
  it("calls a time limit a timeout and anything else an error", () => {
    const timeout = new Error("x");
    timeout.name = "TimeoutError";
    const aborted = new Error("x");
    aborted.name = "AbortError";
    expect(outcomeOf(timeout)).toBe("timeout");
    expect(outcomeOf(aborted)).toBe("timeout");
    expect(outcomeOf(new Error("database down"))).toBe("error");
    expect(outcomeOf("not an error")).toBe("error");
  });
});
