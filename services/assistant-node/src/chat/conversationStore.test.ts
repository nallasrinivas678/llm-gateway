import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ConversationNotFoundError, createSupabaseConversationStore } from "./conversationStore.js";

interface Logged {
  table: string;
  op: "select" | "insert";
  payload?: unknown;
  filters: Record<string, unknown>;
}

// A tiny stand-in for the supabase-js query builder: it records what was asked and answers from
// the rows given. `any` is used on purpose here, to mimic a fluent API without copying its types.
function fakeSupabase(data: { conversations?: Record<string, unknown>[]; messages?: Record<string, unknown>[]; failWith?: string } = {}) {
  const log: Logged[] = [];
  const client = {
    from(table: string) {
      const entry: Logged = { table, op: "select", filters: {} };
      log.push(entry);
      const run = () => {
        if (data.failWith) return { data: null, error: { code: data.failWith } };
        if (table === "conversations" && entry.op === "select") {
          return { data: (data.conversations ?? []).find((c) => c.id === entry.filters.id) ?? null, error: null };
        }
        if (table === "conversations") return { data: { id: "new-conversation" }, error: null };
        if (entry.op === "select") {
          return { data: (data.messages ?? []).filter((m) => m.conversation_id === entry.filters.conversation_id), error: null };
        }
        return { data: null, error: null };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        insert: (payload: unknown) => {
          entry.op = "insert";
          entry.payload = payload;
          return chain;
        },
        eq: (key: string, value: unknown) => {
          entry.filters[key] = value;
          return chain;
        },
        order: () => chain,
        maybeSingle: () => Promise.resolve(run()),
        single: () => Promise.resolve(run()),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, log };
}

describe("conversation store", () => {
  it("creates a conversation for the caller when no id is given", async () => {
    const { client, log } = fakeSupabase();
    const id = await createSupabaseConversationStore(client, "user-1").ensureConversation();

    expect(id).toBe("new-conversation");
    expect(log[0]).toMatchObject({ table: "conversations", op: "insert", payload: { user_id: "user-1" } });
  });

  it("returns an existing conversation the caller can see", async () => {
    const { client } = fakeSupabase({ conversations: [{ id: "c-1" }] });
    expect(await createSupabaseConversationStore(client, "user-1").ensureConversation("c-1")).toBe("c-1");
  });

  it("says 'not found' for a conversation the database does not show (someone else's, or missing)", async () => {
    const { client } = fakeSupabase({ conversations: [] });
    await expect(createSupabaseConversationStore(client, "user-1").ensureConversation("c-404")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("turns database errors into plain errors without the database message", async () => {
    const { client } = fakeSupabase({ failWith: "42501" });
    const error = await createSupabaseConversationStore(client, "u").ensureConversation().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("42501");
  });

  it("loads messages of one conversation as LangChain messages", async () => {
    const { client, log } = fakeSupabase({
      messages: [
        { conversation_id: "c-1", role: "user", content: "hi", tool_call_id: null, tool_calls: null },
        { conversation_id: "c-2", role: "user", content: "other", tool_call_id: null, tool_calls: null },
      ],
    });
    const messages = await createSupabaseConversationStore(client, "u").loadMessages("c-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("hi");
    expect(log[0]?.filters).toEqual({ conversation_id: "c-1" });
  });

  it("saves a whole turn in one insert, with increasing timestamps so the order is kept", async () => {
    const { client, log } = fakeSupabase();
    await createSupabaseConversationStore(client, "u").appendMessages("c-1", [
      { role: "user", content: "a", toolCallId: null, toolCalls: null },
      { role: "assistant", content: "b", toolCallId: null, toolCalls: [{ Id: "1", ToolName: "t", ArgumentsJson: "{}" }] },
      { role: "tool", content: "c", toolCallId: "1", toolCalls: null },
    ]);

    const inserts = log.filter((l) => l.op === "insert");
    expect(inserts).toHaveLength(1);
    const rows = inserts[0]?.payload as { created_at: string; role: string; conversation_id: string; tool_call_id: string | null }[];
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "tool"]);
    expect(rows.every((r) => r.conversation_id === "c-1")).toBe(true);
    expect(rows[2]?.tool_call_id).toBe("1");
    const times = rows.map((r) => Date.parse(r.created_at));
    expect(times[1]! - times[0]!).toBe(1);
    expect(times[2]! - times[1]!).toBe(1);
  });

  it("does nothing when there is nothing to save", async () => {
    const { client, log } = fakeSupabase();
    await createSupabaseConversationStore(client, "u").appendMessages("c-1", []);
    expect(log).toHaveLength(0);
  });
});
