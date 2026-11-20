// The user's TaskTide tasks as chat tools. Tasks live in the `events` table (type = 'task') of the
// web app's database. The Supabase client is built with the user's own token, so row-level
// security applies: another user's task cannot be read, created or completed from here.
//
// Scope, on purpose: create adds a one-off task, complete marks one occurrence done, and list
// shows tasks by their date. A recurring task is listed once, with its repeat rule, not expanded.
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export const PRIORITIES = ["none", "low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TaskSummary {
  id: string;
  title: string;
  dueDate: string;
  priority: Priority;
  notes: string | null;
  // Set for a repeating task: how often it repeats (the date is its first occurrence).
  repeats: string | null;
  done: boolean;
}

export interface TaskStore {
  list(options: { from?: string; to?: string; includeDone: boolean; limit: number }): Promise<TaskSummary[]>;
  create(task: { title: string; dueDate: string; notes?: string; priority: Priority }): Promise<{ id: string }>;
  // Marks one occurrence done (the task's own date unless one is given). Null when no such task.
  complete(taskId: string, occurrenceDate?: string): Promise<{ title: string; occurrenceDate: string } | null>;
}

const MAX_ROWS = 200;

interface EventRow {
  id: string;
  title: string;
  event_date: string;
  priority: Priority;
  notes: string | null;
  recurrence_freq: string | null;
}

export function createSupabaseTaskStore(client: SupabaseClient, userId: string, now: () => Date = () => new Date()): TaskStore {
  const fail = (what: string, code?: string) => new Error(`Could not ${what} (${code ?? "unknown"})`);

  return {
    async list({ from, to, includeDone, limit }) {
      let query = client
        .from("events")
        .select("id, title, event_date, priority, notes, recurrence_freq")
        .eq("type", "task")
        .order("event_date", { ascending: true })
        .limit(MAX_ROWS);
      // A repeating task is always a candidate, because its later occurrences may fall in the range.
      if (from && to) query = query.or(`and(event_date.gte.${from},event_date.lte.${to}),recurrence_freq.not.is.null`);
      else if (from) query = query.or(`event_date.gte.${from},recurrence_freq.not.is.null`);
      else if (to) query = query.lte("event_date", to);
      const { data, error } = await query;
      if (error) throw fail("read tasks", error.code);
      const rows = (data ?? []) as EventRow[];

      const done = new Set<string>();
      if (rows.length > 0) {
        const { data: occurrences, error: occurrenceError } = await client
          .from("event_occurrences")
          .select("event_id, occurrence_date")
          .eq("status", "done")
          .in("event_id", rows.map((r) => r.id));
        if (occurrenceError) throw fail("read tasks", occurrenceError.code);
        for (const o of occurrences ?? []) done.add(`${o.event_id}:${o.occurrence_date}`);
      }

      return rows
        .map((r) => ({
          id: r.id,
          title: r.title,
          dueDate: r.event_date,
          priority: r.priority,
          notes: r.notes,
          repeats: r.recurrence_freq,
          done: done.has(`${r.id}:${r.event_date}`),
        }))
        .filter((task) => includeDone || !task.done)
        .slice(0, limit);
    },

    async create(task) {
      const { data, error } = await client
        .from("events")
        .insert({ user_id: userId, type: "task", title: task.title, event_date: task.dueDate, notes: task.notes ?? null, priority: task.priority })
        .select("id")
        .single();
      if (error) throw fail("create the task", error.code);
      return { id: data.id as string };
    },

    async complete(taskId, occurrenceDate) {
      const { data, error } = await client.from("events").select("id, title, event_date").eq("id", taskId).eq("type", "task").maybeSingle();
      if (error) throw fail("read the task", error.code);
      if (!data) return null;
      const date = occurrenceDate ?? (data.event_date as string);
      const { error: saveError } = await client
        .from("event_occurrences")
        .upsert({ user_id: userId, event_id: taskId, occurrence_date: date, status: "done", completed_at: now().toISOString() }, { onConflict: "event_id,occurrence_date" });
      if (saveError) throw fail("complete the task", saveError.code);
      return { title: data.title as string, occurrenceDate: date };
    },
  };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-11-24");

// A failure comes back as text so the model can tell the user, like the other tools.
async function guarded(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch {
    return "The task tool failed. Tell the user tasks are unavailable right now.";
  }
}

export function taskTools(store: TaskStore): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: "list_tasks",
      description:
        "List the user's TaskTide tasks (their to-do list, separate from Google Calendar events), earliest first. Optionally only those from a date and/or up to a date. Done tasks are left out unless includeDone is true. A repeating task appears once with its repeat rule.",
      schema: z.object({
        from: date.optional().describe("Earliest due date, YYYY-MM-DD"),
        to: date.optional().describe("Latest due date, YYYY-MM-DD"),
        includeDone: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional().describe("How many to return, default 20"),
      }),
      func: ({ from, to, includeDone, limit }) =>
        guarded(async () => {
          const tasks = await store.list({ from, to, includeDone: includeDone ?? false, limit: limit ?? 20 });
          return tasks.length === 0 ? "No tasks found." : JSON.stringify(tasks);
        }),
    }),
    new DynamicStructuredTool({
      name: "create_task",
      description: "Add a one-off task to the user's TaskTide to-do list. Needs a title and a due date; ask the user if either is missing.",
      schema: z.object({
        title: z.string().trim().min(1).max(200),
        dueDate: date.describe("Due date, YYYY-MM-DD"),
        notes: z.string().max(2000).optional(),
        priority: z.enum(PRIORITIES).optional().describe("none, low, medium or high; default none"),
      }),
      func: ({ title, dueDate, notes, priority }) =>
        guarded(async () => {
          const { id } = await store.create({ title, dueDate, notes, priority: priority ?? "none" });
          return `Created the task "${title}" due ${dueDate} (id ${id}).`;
        }),
    }),
    new DynamicStructuredTool({
      name: "complete_task",
      description:
        "Mark a task done. Use the id from list_tasks. For a repeating task, pass occurrenceDate (YYYY-MM-DD) to mark that day's occurrence; otherwise the task's own date is marked.",
      schema: z.object({ taskId: z.string().uuid(), occurrenceDate: date.optional() }),
      func: ({ taskId, occurrenceDate }) =>
        guarded(async () => {
          const result = await store.complete(taskId, occurrenceDate);
          return result ? `Marked "${result.title}" done for ${result.occurrenceDate}.` : "No task with that id was found.";
        }),
    }),
  ];
}
