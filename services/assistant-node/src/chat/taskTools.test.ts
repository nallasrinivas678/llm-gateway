import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseTaskStore, taskTools, type TaskStore } from "./taskTools.js";

interface Call {
  table: string;
  calls: [string, unknown[]][];
}

// A stand-in for the supabase-js query builder: it records every call on a table and answers with
// the response given for that table.
function fakeSupabase(responses: Record<string, { data: unknown; error?: { code: string } | null }>) {
  const log: Call[] = [];
  const client = {
    from(table: string) {
      const entry: Call = { table, calls: [] };
      log.push(entry);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(
        {},
        {
          get(_target, method: string) {
            if (method === "then") {
              const r = responses[table] ?? { data: null };
              return (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null, ...r }).then(resolve);
            }
            return (...args: unknown[]) => {
              entry.calls.push([method, args]);
              if (method === "single" || method === "maybeSingle") {
                const r = responses[table] ?? { data: null };
                return Promise.resolve({ error: null, ...r });
              }
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, log };
}

const eventRows = [
  { id: "t1", title: "Pay rent", event_date: "2026-11-24", priority: "high", notes: null, recurrence_freq: null },
  { id: "t2", title: "Water plants", event_date: "2026-11-20", priority: "none", notes: "weekly", recurrence_freq: "weekly" },
  { id: "t3", title: "Call mum", event_date: "2026-11-25", priority: "low", notes: null, recurrence_freq: null },
];

describe("task store", () => {
  it("lists tasks of the user, marks done ones, and leaves them out unless asked", async () => {
    const { client, log } = fakeSupabase({
      events: { data: eventRows },
      event_occurrences: { data: [{ event_id: "t3", occurrence_date: "2026-11-25" }, { event_id: "t2", occurrence_date: "2026-11-27" }] },
    });
    const store = createSupabaseTaskStore(client, "u1");

    const open = await store.list({ includeDone: false, limit: 20 });
    expect(open.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(open[1]).toMatchObject({ repeats: "weekly", done: false });
    expect(log[0]!.calls).toContainEqual(["eq", ["type", "task"]]);

    const all = await store.list({ includeDone: true, limit: 2 });
    expect(all.map((t) => [t.id, t.done])).toEqual([["t1", false], ["t2", false]]);
    expect((await store.list({ includeDone: true, limit: 20 })).find((t) => t.id === "t3")?.done).toBe(true);
  });

  it("keeps repeating tasks when filtering by a date range", async () => {
    const { client, log } = fakeSupabase({ events: { data: [] } });
    await createSupabaseTaskStore(client, "u1").list({ from: "2026-11-23", to: "2026-11-30", includeDone: false, limit: 5 });
    expect(JSON.stringify(log[0]!.calls)).toContain("and(event_date.gte.2026-11-23,event_date.lte.2026-11-30),recurrence_freq.not.is.null");
  });

  it("creates a task for the caller", async () => {
    const { client, log } = fakeSupabase({ events: { data: { id: "new-id" } } });
    const result = await createSupabaseTaskStore(client, "u1").create({ title: "Book flights", dueDate: "2026-12-01", priority: "medium" });
    expect(result).toEqual({ id: "new-id" });
    expect(log[0]!.calls[0]).toEqual(["insert", [{ user_id: "u1", type: "task", title: "Book flights", event_date: "2026-12-01", notes: null, priority: "medium" }]]);
  });

  it("marks the task's own date done, or the date given, and says when there is no such task", async () => {
    const found = fakeSupabase({ events: { data: { id: "t1", title: "Pay rent", event_date: "2026-11-24" } }, event_occurrences: { data: null } });
    const store = createSupabaseTaskStore(found.client, "u1", () => new Date("2026-11-24T10:00:00Z"));

    expect(await store.complete("t1")).toEqual({ title: "Pay rent", occurrenceDate: "2026-11-24" });
    expect(await store.complete("t1", "2026-12-01")).toEqual({ title: "Pay rent", occurrenceDate: "2026-12-01" });
    const upsert = found.log.find((c) => c.table === "event_occurrences")!.calls[0]!;
    expect(upsert[0]).toBe("upsert");
    expect(upsert[1]).toEqual([
      { user_id: "u1", event_id: "t1", occurrence_date: "2026-11-24", status: "done", completed_at: "2026-11-24T10:00:00.000Z" },
      { onConflict: "event_id,occurrence_date" },
    ]);

    const missing = fakeSupabase({ events: { data: null } });
    expect(await createSupabaseTaskStore(missing.client, "u1").complete("nope")).toBeNull();
  });

  it("turns a database error into a short error without the details", async () => {
    const { client } = fakeSupabase({ events: { data: null, error: { code: "42501" } } });
    await expect(createSupabaseTaskStore(client, "u1").list({ includeDone: false, limit: 5 })).rejects.toThrow("Could not read tasks (42501)");
  });
});

function fakeStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    list: async () => [{ id: "t1", title: "Pay rent", dueDate: "2026-11-24", priority: "high", notes: null, repeats: null, done: false }],
    create: async () => ({ id: "new-id" }),
    get: async () => ({ title: "Pay rent", dueDate: "2026-11-24" }),
    complete: async () => ({ title: "Pay rent", occurrenceDate: "2026-11-24" }),
    ...overrides,
  };
}
const byName = (store: TaskStore, name: string) => taskTools(store).find((t) => t.name === name)!;

describe("task tools", () => {
  it("offer list_tasks, create_task and complete_task", () => {
    expect(taskTools(fakeStore()).map((t) => t.name)).toEqual(["list_tasks", "create_task", "complete_task"]);
  });

  it("list_tasks returns the tasks, or says there are none", async () => {
    expect(await byName(fakeStore(), "list_tasks").invoke({})).toContain("Pay rent");
    expect(await byName(fakeStore({ list: async () => [] }), "list_tasks").invoke({})).toBe("No tasks found.");
  });

  it("create_task fills in the default priority and checks its input", async () => {
    let seen: unknown;
    const tool = byName(fakeStore({ create: async (task) => ((seen = task), { id: "x" }) }), "create_task");
    expect(await tool.invoke({ title: "  Book flights ", dueDate: "2026-12-01" })).toContain('Created the task "Book flights" due 2026-12-01');
    expect(seen).toEqual({ title: "Book flights", dueDate: "2026-12-01", notes: undefined, priority: "none" });
    await expect(tool.invoke({ title: "", dueDate: "2026-12-01" })).rejects.toThrow();
    await expect(tool.invoke({ title: "x", dueDate: "tomorrow" })).rejects.toThrow();
    await expect(tool.invoke({ title: "x", dueDate: "2026-12-01", priority: "urgent" })).rejects.toThrow();
  });

  it("complete_task confirms, says when the task is missing, and needs a real id", async () => {
    const id = "3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b";
    expect(await byName(fakeStore(), "complete_task").invoke({ taskId: id })).toBe('Marked "Pay rent" done for 2026-11-24.');
    expect(await byName(fakeStore({ complete: async () => null }), "complete_task").invoke({ taskId: id })).toContain("No task");
    await expect(byName(fakeStore(), "complete_task").invoke({ taskId: "not-an-id" })).rejects.toThrow();
  });

  it("report a store failure as text, without its message", async () => {
    const failing = fakeStore({ list: async () => Promise.reject(new Error("secret detail")), create: async () => Promise.reject(new Error("secret detail")), complete: async () => Promise.reject(new Error("secret detail")) });
    for (const [name, args] of [["list_tasks", {}], ["create_task", { title: "x", dueDate: "2026-12-01" }], ["complete_task", { taskId: "3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b" }]] as const) {
      const text = await byName(failing, name).invoke(args);
      expect(text).toContain("unavailable");
      expect(text).not.toContain("secret");
    }
  });
});
