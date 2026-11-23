// A fake world for the agent evals: one user's tasks, calendar and mailbox in memory, a fake Google
// that records anything that changes, a fake web search, and in-memory stores for conversations,
// proposed changes and run records. A scenario starts from a known state and a run changes nothing real.
import { randomUUID } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import { loadSettings } from "../../src/config.js";
import type { ActionStore, AgentAction, PendingAction } from "../../src/chat/actionStore.js";
import { ConversationNotFoundError, type ConversationStore } from "../../src/chat/conversationStore.js";
import { rowToMessage, type StoredMessage } from "../../src/chat/messageMapper.js";
import type { RunRecord, RunStore } from "../../src/chat/runRecord.js";
import type { TaskStore, TaskSummary } from "../../src/chat/taskTools.js";
import type { WebSearchFn } from "../../src/chat/webSearch.js";
import type { DocumentAccess } from "../../src/chat/documentTools.js";
import { describePatch, type Profile, type ProfileStore } from "../../src/chat/profileTool.js";
import type { WeatherFn } from "../../src/chat/weatherTool.js";
import { DocNotFoundError } from "../../src/docQa/errors.js";
import type { FetchFn } from "../../src/google-mcp/common.js";
import type { Seed } from "./types.js";

export const EVAL_USER = "eval-user";
const urls = loadSettings().google.urls;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createBackend(seed: Seed = {}) {
  const changes: string[] = [];
  const searches: string[] = [];
  const runs: RunRecord[] = [];

  // Tasks. Created ones get fresh ids; a done task stays in the list (hidden unless asked for).
  const tasks: (TaskSummary & { notes: string | null })[] = (seed.tasks ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    dueDate: t.dueDate,
    priority: t.priority ?? "none",
    notes: t.notes ?? null,
    repeats: null,
    done: t.done ?? false,
  }));
  const taskStore: TaskStore = {
    async list({ from, to, includeDone, limit }) {
      return tasks
        .filter((t) => (!from || t.dueDate >= from) && (!to || t.dueDate <= to) && (includeDone || !t.done))
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .slice(0, limit)
        .map((t) => ({ ...t }));
    },
    async create(task) {
      const id = randomUUID();
      tasks.push({ id, title: task.title, dueDate: task.dueDate, priority: task.priority, notes: task.notes ?? null, repeats: null, done: false });
      changes.push(`task created: ${task.title}`);
      return { id };
    },
    async get(id) {
      const task = tasks.find((t) => t.id === id);
      return task ? { title: task.title, dueDate: task.dueDate } : null;
    },
    async complete(id, occurrenceDate) {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      task.done = true;
      changes.push(`task completed: ${task.title}`);
      return { title: task.title, occurrenceDate: occurrenceDate ?? task.dueDate };
    },
  };

  // Google. Reads answer from the seed; anything else is a change and is written down.
  const googleFetch: FetchFn = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.startsWith(urls.calendarEvents) && method === "GET") {
      return json({ items: (seed.events ?? []).map((e) => ({ summary: e.summary, start: { dateTime: e.start }, end: { dateTime: e.end } })) });
    }
    if (url.startsWith(urls.gmailMessages) && method === "GET") {
      const emails = seed.emails ?? [];
      const one = url.slice(urls.gmailMessages.length + 1).split("?")[0];
      if (!one) return json({ messages: emails.map((_, i) => ({ id: `email-id-${i}` })) });
      const email = emails[Number(one.replace("email-id-", ""))];
      if (!email) return json({}, 404);
      const headers = [{ name: "Subject", value: email.subject }, { name: "From", value: email.from }, { name: "Date", value: email.date }];
      // format=full is read_email: the whole body. Anything else is the search's short view.
      if (url.includes("format=full")) {
        return json({ id: one, payload: { headers, mimeType: "text/plain", body: { data: Buffer.from(email.body ?? email.snippet, "utf8").toString("base64url") } } });
      }
      return json({ id: one, snippet: email.snippet, payload: { headers } });
    }
    // Everything else changes something in the user's Google account.
    changes.push(`google ${method} ${url.startsWith(urls.calendarEvents) ? "calendar" : url.startsWith(urls.gmailDrafts) ? "gmail draft" : url.startsWith(urls.docsDocuments) ? "docs" : "other"}`);
    return json({ id: "created-1", summary: "created", start: {}, end: {} });
  };

  const webSearch: WebSearchFn = async (query) => {
    searches.push(query);
    return { answer: "It is open from 9 to 5 and the forecast is mild.", sources: [{ title: "Example", url: "https://example.org" }] };
  };

  // The profile, the user's PDFs and the weather. A saved profile counts as a real change.
  let profile: Profile = { homeCity: seed.profile?.homeCity ?? null, defaultMeetingMinutes: seed.profile?.defaultMeetingMinutes ?? null, timeZone: seed.profile?.timeZone ?? null };
  const profileStore: ProfileStore = {
    async get() {
      return profile;
    },
    async save(patch) {
      profile = { ...profile, ...patch };
      changes.push(`profile saved: ${describePatch(patch)}`);
      return profile;
    },
  };
  const documents: DocumentAccess = {
    async list() {
      return (seed.documents ?? []).map((d) => ({ id: d.id, title: d.title, pageCount: 3 }));
    },
    async ask(documentId) {
      const doc = (seed.documents ?? []).find((d) => d.id === documentId);
      if (!doc) throw new DocNotFoundError();
      return { answer: doc.answer, sources: [{ page: 2 }] };
    },
  };
  const weather: WeatherFn = async (location) => ({
    place: `${location}, United States`,
    days: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-11-${String(20 + i).padStart(2, "0")}`,
      highC: 17,
      lowC: 8,
      // Saturday the 21st is the rainy day.
      rainChance: i === 1 ? 80 : 10,
      summary: i === 1 ? "rain" : "partly cloudy",
    })),
  });

  // Conversations, proposals and run records, in memory.
  const conversations = new Map<string, StoredMessage[]>();
  const conversationStore: ConversationStore = {
    async ensureConversation(id, title) {
      if (!id) {
        const created = `conv-${conversations.size + 1}`;
        conversations.set(created, []);
        void title;
        return created;
      }
      if (!conversations.has(id)) throw new ConversationNotFoundError();
      return id;
    },
    async loadMessages(id): Promise<BaseMessage[]> {
      return (conversations.get(id) ?? []).map((m) => rowToMessage({ role: m.role, content: m.content, tool_call_id: m.toolCallId, tool_calls: m.toolCalls }));
    },
    async appendMessages(id, messages) {
      conversations.set(id, [...(conversations.get(id) ?? []), ...messages]);
    },
    async listConversations() {
      return [...conversations.keys()].map((id) => ({ id, title: null, createdAt: "t", updatedAt: "t" }));
    },
    async getConversation(id) {
      if (!conversations.has(id)) throw new ConversationNotFoundError();
      return { id, title: null, createdAt: "t", updatedAt: "t" };
    },
    async deleteConversation(id) {
      conversations.delete(id);
    },
  };

  const actions = new Map<string, AgentAction>();
  const actionStore: ActionStore = {
    async propose(a) {
      const id = `act-${actions.size + 1}`;
      actions.set(id, { id, conversationId: a.conversationId, tool: a.tool, args: a.args, preview: a.preview, status: "pending", result: null, expiresAt: "2099-01-01T00:00:00Z" });
      return { id, tool: a.tool, preview: a.preview };
    },
    async get(id) {
      return actions.get(id) ?? null;
    },
    async claim(id) {
      const row = actions.get(id);
      if (!row || row.status !== "pending") return null;
      row.status = "running";
      return { ...row };
    },
    async finish(id, status, result) {
      Object.assign(actions.get(id)!, { status, result });
    },
    async reject(id) {
      const row = actions.get(id);
      if (!row || row.status !== "pending") return false;
      row.status = "rejected";
      return true;
    },
    async listPending(conversationId) {
      return [...actions.values()]
        .filter((a) => a.conversationId === conversationId && a.status === "pending")
        .map((a): PendingAction => ({ id: a.id, tool: a.tool, preview: a.preview }));
    },
  };

  const runStore: RunStore = {
    async record(run) {
      runs.push(run);
    },
  };

  return { taskStore, googleFetch, webSearch, profileStore, documents, weather, conversationStore, actionStore, runStore, conversations, actions, changes, searches, runs };
}

export type Backend = ReturnType<typeof createBackend>;
