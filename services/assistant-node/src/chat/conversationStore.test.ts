import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ConversationNotFoundError, createSupabaseConversationStore } from "./conversationStore.js";

interface Logged {
  table: string;
  op: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: Record<string, unknown>;
  order?: { column: string; ascending: boolean };
  limit?: number;
}

// A tiny stand-in for the supabase-js query builder: it records what was asked and answers from
// the rows given. `any` is used on purpose here, to mimic a fluent API without copying its types.
function fakeSupabase(
  data: { conversations?: Record<string, unknown>[]; messages?: Record<string, unknown>[]; failWith?: string; failOn?: Logged["op"] } = {},
) {
  const log: Logged[] = [];
  const client = {
    from(table: string) {
      const entry: Logged = { table, op: "select", filters: {} };
      log.push(entry);
      const run = () => {
        if (data.failWith && (!data.failOn || data.failOn === entry.op)) return { data: null, error: { code: data.failWith } };
        const conversations = data.conversations ?? [];
        if (table === "conversations" && entry.op === "select") {
          if (!("id" in entry.filters)) return { data: conversations.slice(0, entry.limit), error: null };
          return { data: conversations.find((c) => c.id === entry.filters.id) ?? null, error: null };
        }
        if (table === "conversations" && entry.op === "delete") {
          return { data: conversations.filter((c) => c.id === entry.filters.id).map((c) => ({ id: c.id })), error: null };
        }
        if (table === "conversations" && entry.op === "update") return { data: null, error: null };
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
        update: (payload: unknown) => {
          entry.op = "update";
          entry.payload = payload;
          return chain;
        },
        delete: () => {
          entry.op = "delete";
          return chain;
        },
        eq: (key: string, value: unknown) => {
          entry.filters[key] = value;
          return chain;
        },
        order: (column: string, options: { ascending: boolean }) => {
          entry.order = { column, ascending: options.ascending };
          return chain;
        },
        limit: (n: number) => {
          entry.limit = n;
          return chain;
        },
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
  it("stores the title given for a new conversation", async () => {
    const { client, log } = fakeSupabase();
    await createSupabaseConversationStore(client, "user-1").ensureConversation(undefined, "Plan my week");
    expect(log[0]).toMatchObject({ op: "insert", payload: { user_id: "user-1", title: "Plan my week" } });
  });

  it("moves the conversation to the top of the list after saving a turn", async () => {
    const { client, log } = fakeSupabase();
    await createSupabaseConversationStore(client, "u").appendMessages("c-1", [{ role: "user", content: "a", toolCallId: null, toolCalls: null }]);
    const update = log.find((l) => l.op === "update");
    expect(update).toMatchObject({ table: "conversations", filters: { id: "c-1" } });
    expect(Date.parse((update?.payload as { updated_at: string }).updated_at)).not.toBeNaN();
  });

  it("reports a failure to update the list order without the database message", async () => {
    const { client } = fakeSupabase({ failWith: "42501", failOn: "update" });
    const error = await createSupabaseConversationStore(client, "u")
      .appendMessages("c-1", [{ role: "user", content: "a", toolCallId: null, toolCalls: null }])
      .catch((e: Error) => e);
    expect((error as Error).message).toBe("Could not update the conversation (42501)");
  });

  it("lists the caller's conversations, most recently used first, up to a limit", async () => {
    const { client, log } = fakeSupabase({
      conversations: [
        { id: "c-2", title: "Newer", created_at: "2026-11-19T00:00:00Z", updated_at: "2026-11-20T00:00:00Z" },
        { id: "c-1", title: null, created_at: "2026-11-18T00:00:00Z", updated_at: "2026-11-18T00:00:00Z" },
      ],
    });
    const list = await createSupabaseConversationStore(client, "u").listConversations(1);
    expect(list).toEqual([{ id: "c-2", title: "Newer", createdAt: "2026-11-19T00:00:00Z", updatedAt: "2026-11-20T00:00:00Z" }]);
    expect(log[0]).toMatchObject({ table: "conversations", order: { column: "updated_at", ascending: false }, limit: 1 });
  });

  it("reads one conversation, and says not found for one the database does not show", async () => {
    const row = { id: "c-1", title: "T", created_at: "a", updated_at: "b" };
    const store = createSupabaseConversationStore(fakeSupabase({ conversations: [row] }).client, "u");
    expect(await store.getConversation("c-1")).toEqual({ id: "c-1", title: "T", createdAt: "a", updatedAt: "b" });
    await expect(store.getConversation("c-404")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("deletes a conversation, and says not found when nothing was deleted (someone else's, or missing)", async () => {
    const { client, log } = fakeSupabase({ conversations: [{ id: "c-1" }] });
    const store = createSupabaseConversationStore(client, "u");
    await store.deleteConversation("c-1");
    expect(log[0]).toMatchObject({ table: "conversations", op: "delete", filters: { id: "c-1" } });
    await expect(store.deleteConversation("c-404")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it.each([
    ["list", (s: ReturnType<typeof createSupabaseConversationStore>) => s.listConversations(10)],
    ["read", (s: ReturnType<typeof createSupabaseConversationStore>) => s.getConversation("c-1")],
    ["delete", (s: ReturnType<typeof createSupabaseConversationStore>) => s.deleteConversation("c-1")],
  ])("turns a database error on %s into a plain error with only its code", async (_label, act) => {
    const error = await act(createSupabaseConversationStore(fakeSupabase({ failWith: "42501" }).client, "u")).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/^Could not .+ \(42501\)$/);
  });
});
