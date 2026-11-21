import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseActionStore } from "./actionStore.js";

interface Logged {
  op: "select" | "insert" | "update";
  payload?: unknown;
  filters: Record<string, unknown>;
  after?: string;
  order?: string;
  columns?: string;
}

const now = () => new Date("2026-11-20T12:00:00Z");
const row = { id: "a-1", conversation_id: "c-1", tool: "create_task", args: { title: "x" }, preview: "Add x", status: "pending", result: null, expires_at: "2026-11-21T12:00:00Z" };

// A tiny stand-in for the supabase-js query builder: it records what was asked and answers with `rows`.
function fakeSupabase(options: { rows?: unknown[]; failWith?: string } = {}) {
  const log: Logged[] = [];
  const client = {
    from(table: string) {
      const entry: Logged = { op: "select", filters: {} };
      log.push(entry);
      const run = () => (options.failWith ? { data: null, error: { code: options.failWith } } : { data: options.rows ?? [], error: null });
      expect(table).toBe("agent_actions");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: (columns?: string) => {
          entry.columns = columns;
          return chain;
        },
        insert: (payload: unknown) => ((entry.op = "insert"), (entry.payload = payload), chain),
        update: (payload: unknown) => ((entry.op = "update"), (entry.payload = payload), chain),
        eq: (key: string, value: unknown) => ((entry.filters[key] = value), chain),
        gt: (key: string, value: string) => ((entry.after = `${key}>${value}`), chain),
        order: (column: string) => ((entry.order = column), chain),
        maybeSingle: () => Promise.resolve({ ...run(), data: (options.rows ?? [])[0] ?? null }),
        single: () => Promise.resolve({ ...run(), data: { id: "new-action" } }),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, log };
}

describe("action store", () => {
  it("saves a proposal for the caller and returns the card", async () => {
    const { client, log } = fakeSupabase();
    const card = await createSupabaseActionStore(client, "user-1", now).propose({ conversationId: "c-1", tool: "create_task", args: { title: "x" }, preview: "Add x" });

    expect(card).toEqual({ id: "new-action", tool: "create_task", preview: "Add x" });
    expect(log[0]).toMatchObject({ op: "insert", payload: { user_id: "user-1", conversation_id: "c-1", tool: "create_task", args: { title: "x" }, preview: "Add x" } });
  });

  it("cuts a preview to the length the table allows", async () => {
    const { client, log } = fakeSupabase();
    await createSupabaseActionStore(client, "u", now).propose({ conversationId: "c", tool: "t", args: {}, preview: "x".repeat(900) });
    expect(((log[0]!.payload as { preview: string }).preview).length).toBe(500);
  });

  it("reads one action as the caller sees it, and null when the database shows none", async () => {
    const found = await createSupabaseActionStore(fakeSupabase({ rows: [row] }).client, "u", now).get("a-1");
    expect(found).toEqual({ id: "a-1", conversationId: "c-1", tool: "create_task", args: { title: "x" }, preview: "Add x", status: "pending", result: null, expiresAt: "2026-11-21T12:00:00Z" });
    expect(await createSupabaseActionStore(fakeSupabase({ rows: [] }).client, "u", now).get("nope")).toBeNull();
  });

  it("claims only a pending action that has not expired, in one update", async () => {
    const { client, log } = fakeSupabase({ rows: [{ ...row, status: "running" }] });
    const claimed = await createSupabaseActionStore(client, "u", now).claim("a-1");

    expect(claimed?.status).toBe("running");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ op: "update", payload: { status: "running" }, filters: { id: "a-1", status: "pending" }, after: "expires_at>2026-11-20T12:00:00.000Z" });
  });

  it("gets null when nothing could be claimed (decided, running or expired)", async () => {
    expect(await createSupabaseActionStore(fakeSupabase({ rows: [] }).client, "u", now).claim("a-1")).toBeNull();
  });

  it("records the outcome, cut to the length the table allows", async () => {
    const { client, log } = fakeSupabase();
    await createSupabaseActionStore(client, "u", now).finish("a-1", "failed", "y".repeat(900));
    expect(log[0]).toMatchObject({ op: "update", filters: { id: "a-1" } });
    expect(log[0]!.payload).toMatchObject({ status: "failed" });
    expect(((log[0]!.payload as { result: string }).result).length).toBe(500);
  });

  it("rejects only a pending action, and says whether it did", async () => {
    const yes = fakeSupabase({ rows: [{ id: "a-1" }] });
    expect(await createSupabaseActionStore(yes.client, "u", now).reject("a-1")).toBe(true);
    expect(yes.log[0]).toMatchObject({ op: "update", payload: { status: "rejected" }, filters: { id: "a-1", status: "pending" } });
    expect(await createSupabaseActionStore(fakeSupabase({ rows: [] }).client, "u", now).reject("a-1")).toBe(false);
  });

  it("lists the pending, unexpired actions of one conversation, oldest first", async () => {
    const { client, log } = fakeSupabase({ rows: [{ id: "a-1", tool: "create_task", preview: "Add x" }] });
    expect(await createSupabaseActionStore(client, "u", now).listPending("c-1")).toEqual([{ id: "a-1", tool: "create_task", preview: "Add x" }]);
    expect(log[0]).toMatchObject({ filters: { conversation_id: "c-1", status: "pending" }, after: "expires_at>2026-11-20T12:00:00.000Z", order: "created_at" });
  });

  it("turns a database error into a plain error with only its code", async () => {
    const store = createSupabaseActionStore(fakeSupabase({ failWith: "42501" }).client, "u", now);
    for (const act of [
      () => store.propose({ conversationId: "c", tool: "t", args: {}, preview: "p" }),
      () => store.get("a"),
      () => store.claim("a"),
      () => store.finish("a", "done", "ok"),
      () => store.reject("a"),
      () => store.listPending("c"),
    ]) {
      expect(((await act().catch((e: Error) => e)) as Error).message).toMatch(/^Could not .+ \(42501\)$/);
    }
  });
});
