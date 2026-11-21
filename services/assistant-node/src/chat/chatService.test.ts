import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../config.js";
import type { FetchFn } from "../google-mcp/common.js";
import { GoogleReconnectRequired } from "../google-tokens/tokenService.js";
import { createChatService, titleFrom, toViewMessages, TOO_MANY_STEPS_REPLY } from "./chatService.js";
import { ConversationNotFoundError, type ConversationStore } from "./conversationStore.js";
import { rowToMessage, type StoredMessage } from "./messageMapper.js";
import type { ActionStore, AgentAction, PendingAction } from "./actionStore.js";
import { ActionNotFoundError, ActionNotPendingError } from "./approval.js";
import type { TaskStore } from "./taskTools.js";
import type { WebSearchFn } from "./webSearch.js";

const settings = loadSettings();

// A fake model that replies with the messages it was given, in order, and remembers every
// conversation it was shown. (LangChain's own fake streaming model drops tool calls.)
class RecordingModel extends BaseChatModel {
  seen: BaseMessage[][] = [];
  private next = 0;

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType() {
    return "scripted";
  }

  // The agent calls this to attach tools; the fake ignores them but must stay the same object.
  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const message = this.script[Math.min(this.next++, this.script.length - 1)]!;
    return { generations: [{ message, text: typeof message.content === "string" ? message.content : "" }] };
  }
}

const toolCall = (name: string, args: Record<string, unknown>, id = "call-1") =>
  new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }] });
const model = (...responses: AIMessage[]) => new RecordingModel(responses);

function memoryStore() {
  const conversations = new Map<string, string | null>(); // id -> title
  const rows = new Map<string, StoredMessage[]>();
  const summary = (id: string) => ({ id, title: conversations.get(id) ?? null, createdAt: "t", updatedAt: "t" });
  const store: ConversationStore = {
    async ensureConversation(id, title) {
      if (!id) {
        const created = `conv-${conversations.size + 1}`;
        conversations.set(created, title ?? null);
        return created;
      }
      if (!conversations.has(id)) throw new ConversationNotFoundError();
      return id;
    },
    async listConversations(limit) {
      return [...conversations.keys()].reverse().slice(0, limit).map(summary);
    },
    async getConversation(id) {
      if (!conversations.has(id)) throw new ConversationNotFoundError();
      return summary(id);
    },
    async deleteConversation(id) {
      if (!conversations.delete(id)) throw new ConversationNotFoundError();
      rows.delete(id);
    },
    async loadMessages(id) {
      return (rows.get(id) ?? []).map((m) =>
        rowToMessage({ role: m.role, content: m.content, tool_call_id: m.toolCallId, tool_calls: m.toolCalls }),
      );
    },
    async appendMessages(id, messages) {
      rows.set(id, [...(rows.get(id) ?? []), ...messages]);
    },
  };
  return { store, rows };
}

function fakeGoogle(status = 200, body: unknown = { items: [] }) {
  const authHeaders: string[] = [];
  const googleFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    authHeaders.push((init?.headers as Record<string, string>).Authorization ?? "");
    return new Response(JSON.stringify(body), { status });
  }) as FetchFn;
  return { googleFetch, authHeaders };
}

function setup(
  chatModel: RecordingModel,
  options: {
    google?: ReturnType<typeof fakeGoogle>;
    token?: () => Promise<string>;
    maxToolRounds?: number;
    chat?: Partial<typeof settings.chat>;
    webSearch?: WebSearchFn;
    openTasks?: (userId: string, jwt: string) => TaskStore;
    openActions?: (userId: string, jwt: string) => ActionStore;
  } = {},
) {
  const memory = memoryStore();
  const google = options.google ?? fakeGoogle();
  const service = createChatService({
    model: chatModel,
    settings: { ...settings, chat: { ...settings.chat, maxToolRounds: options.maxToolRounds ?? settings.chat.maxToolRounds, ...options.chat } },
    getGoogleToken: options.token ?? (async () => "google-token"),
    openStore: () => memory.store,
    googleFetch: google.googleFetch,
    webSearch: options.webSearch,
    openTasks: options.openTasks,
    openActions: options.openActions,
    now: () => new Date("2026-11-17T12:00:00Z"),
  });
  return { service, memory, google, chatModel };
}

const input = { userId: "user-1", jwt: "jwt", message: "What is on my calendar?" };
// The system message's content may be a list of blocks, so look at its JSON text.
const systemPromptOf = (chatModel: RecordingModel) => JSON.stringify(chatModel.seen[0]?.[0]?.content);

describe("chat service", () => {
  it("answers a plain question without calling any tool", async () => {
    const { service, memory } = setup(model(new AIMessage("Hello there!")));

    const result = await service.chat({ ...input, message: "Hi" });

    expect(result).toEqual({ conversationId: "conv-1", reply: "Hello there!", toolCallsExecuted: [], pendingActions: [] });
    expect(memory.rows.get("conv-1")?.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("calls a Google tool with the user's token and saves the whole turn", async () => {
    const google = fakeGoogle(200, { items: [{ summary: "Standup", start: { dateTime: "2026-11-18T09:00:00Z" }, end: { dateTime: "2026-11-18T09:15:00Z" } }] });
    const { service, memory } = setup(model(toolCall("list_events", { maxResults: 3 }), new AIMessage("You have Standup tomorrow at 9.")), { google });

    const result = await service.chat(input);

    expect(result.reply).toBe("You have Standup tomorrow at 9.");
    expect(result.toolCallsExecuted).toEqual(["list_events"]);
    expect(google.authHeaders).toEqual(["Bearer google-token"]);

    const saved = memory.rows.get("conv-1")!;
    expect(saved.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(saved[1]?.toolCalls).toEqual([{ Id: "call-1", ToolName: "list_events", ArgumentsJson: '{"maxResults":3}' }]);
    expect(saved[2]?.toolCallId).toBe("call-1");
    expect(saved[2]?.content).toContain("Standup");
  });

  it("lets the model search the web when a search is configured, even without a Google account", async () => {
    const queries: string[] = [];
    const webSearch: WebSearchFn = async (query) => {
      queries.push(query);
      return { answer: "It opens at 9.", sources: [{ title: "Site", url: "https://site.example" }] };
    };
    const reconnect = async () => {
      throw new GoogleReconnectRequired("connect");
    };
    const { service, memory, chatModel } = setup(model(toolCall("web_search", { query: "museum opening hours" }), new AIMessage("It opens at 9.")), { webSearch, token: reconnect });

    const result = await service.chat(input);

    expect(queries).toEqual(["museum opening hours"]);
    expect(result.toolCallsExecuted).toEqual(["web_search"]);
    expect(memory.rows.get("conv-1")!.find((m) => m.role === "tool")?.content).toContain("https://site.example");
    expect(systemPromptOf(chatModel)).toContain("web_search");
  });

  it("gives the model the user's task tools, opened with the caller's own token", async () => {
    const opened: string[][] = [];
    const created: unknown[] = [];
    const openTasks = (userId: string, jwt: string): TaskStore => {
      opened.push([userId, jwt]);
      return { list: async () => [], create: async (task) => (created.push(task), { id: "t-1" }), get: async () => null, complete: async () => null };
    };
    const { service, chatModel } = setup(model(toolCall("create_task", { title: "Pay rent", dueDate: "2026-11-24" }), new AIMessage("Done.")), { openTasks });

    const result = await service.chat(input);

    expect(opened).toEqual([["user-1", "jwt"]]);
    expect(created).toEqual([{ title: "Pay rent", dueDate: "2026-11-24", notes: undefined, priority: "none" }]);
    expect(result.toolCallsExecuted).toEqual(["create_task"]);
    expect(systemPromptOf(chatModel)).toContain("list_tasks");
  });

  it("does not mention web search when none is configured", async () => {
    const { service, chatModel } = setup(model(new AIMessage("Hi")));
    await service.chat(input);
    expect(systemPromptOf(chatModel)).not.toContain("web_search");
  });

  it("sends earlier messages of the conversation to the model on the next turn", async () => {
    const chatModel = model(new AIMessage("First answer"), new AIMessage("Second answer"));
    const { service } = setup(chatModel);

    const first = await service.chat({ ...input, message: "first question" });
    await service.chat({ ...input, conversationId: first.conversationId, message: "second question" });

    const secondTurn = chatModel.seen[1]!.map((m) => String(m.content));
    expect(secondTurn).toEqual(expect.arrayContaining(["first question", "First answer", "second question"]));
  });

  it("sends only the recent part of a long conversation to the model, but saves everything", async () => {
    const chatModel = model(new AIMessage("a1"), new AIMessage("a2"), new AIMessage("a3"));
    const { service, memory } = setup(chatModel, { chat: { maxHistoryMessages: 2 } });

    const first = await service.chat({ ...input, message: "q1" });
    await service.chat({ ...input, conversationId: first.conversationId, message: "q2" });
    await service.chat({ ...input, conversationId: first.conversationId, message: "q3" });

    // Third turn: history is q1, a1, q2, a2; with a limit of 2 only q2 and a2 are sent, plus q3.
    const thirdTurn = chatModel.seen[2]!.map((m) => String(m.content));
    expect(thirdTurn).toEqual(expect.arrayContaining(["q2", "a2", "q3"]));
    expect(thirdTurn).not.toContain("q1");
    expect(memory.rows.get(first.conversationId)).toHaveLength(6);
  });

  it("stops a run that takes longer than the time limit", async () => {
    class SlowModel extends RecordingModel {
      async _generate(messages: BaseMessage[]): Promise<ChatResult> {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return super._generate(messages);
      }
    }
    const { service, memory } = setup(new SlowModel([new AIMessage("too late")]), { chat: { runTimeoutSeconds: 0.05 } });

    await expect(service.chat(input)).rejects.toMatchObject({ name: expect.stringMatching(/TimeoutError|AbortError/) });
    expect(memory.rows.get("conv-1") ?? []).toEqual([]);
  });

  it("gives the model rules and today's date, and tells it about the draft-only limit", async () => {
    const chatModel = model(new AIMessage("ok"));
    await setup(chatModel).service.chat(input);

    const prompt = systemPromptOf(chatModel);
    expect(prompt).toContain("2026-11-17");
    expect(prompt).toMatch(/cannot send email/i);
    expect(prompt).toMatch(/data, not instructions/i);
    expect(prompt).not.toMatch(/not connected/i);
  });

  it("still chats when Google is not connected, and tells the model so", async () => {
    const chatModel = model(new AIMessage("Please connect Google first."));
    const { service } = setup(chatModel, {
      token: async () => {
        throw new GoogleReconnectRequired("not connected");
      },
    });

    const result = await service.chat(input);

    expect(result.reply).toBe("Please connect Google first.");
    expect(systemPromptOf(chatModel)).toMatch(/not connected/i);
  });

  it("fails loudly on any other token error instead of hiding it", async () => {
    const { service } = setup(model(new AIMessage("x")), {
      token: async () => {
        throw new Error("database down");
      },
    });
    await expect(service.chat(input)).rejects.toThrow("database down");
  });

  it("lets the model recover when a Google call fails", async () => {
    const { service, memory } = setup(model(toolCall("list_events", {}), new AIMessage("I couldn't reach your calendar.")), {
      google: fakeGoogle(401, { error: "secret-detail" }),
    });

    const result = await service.chat(input);

    expect(result.reply).toBe("I couldn't reach your calendar.");
    const toolRow = memory.rows.get("conv-1")!.find((m) => m.role === "tool")!;
    expect(toolRow.content).toMatch(/reconnect/i);
    expect(toolRow.content).not.toContain("secret-detail");
  });

  it("stops a model that keeps calling tools and answers with an apology instead of an error", async () => {
    const endless = Array.from({ length: 40 }, (_, i) => toolCall("list_events", {}, `call-${i}`));
    const { service, memory } = setup(model(...endless), { maxToolRounds: 2 });

    const result = await service.chat(input);

    expect(result.reply).toBe(TOO_MANY_STEPS_REPLY);
    expect(result.toolCallsExecuted).toEqual([]);
    expect(memory.rows.get("conv-1")?.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("refuses a conversation that is not the caller's", async () => {
    const { service } = setup(model(new AIMessage("x")));
    await expect(service.chat({ ...input, conversationId: "someone-elses" })).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe("saved conversations", () => {
  it("titles a new conversation with its first message, and leaves an existing one alone", async () => {
    const { service, memory } = setup(model(new AIMessage("Sure."), new AIMessage("Done.")));
    const first = await service.chat({ ...input, message: "  What is   on my calendar?  " });
    await service.chat({ ...input, conversationId: first.conversationId, message: "And tomorrow?" });

    const view = await service.get("user-1", "jwt", first.conversationId);
    expect(view.title).toBe("What is on my calendar?");
    expect((await service.list("user-1", "jwt")).map((c) => c.id)).toEqual([first.conversationId]);
    expect(memory.rows.get(first.conversationId)).toHaveLength(4);
  });

  it("shows the user's messages and each final answer with its tools, never tool calls or tool output", async () => {
    const google = fakeGoogle(200, { items: [{ summary: "Secret meeting", start: { dateTime: "2026-11-18T09:00:00Z" }, end: { dateTime: "2026-11-18T09:15:00Z" } }] });
    const { service } = setup(model(toolCall("list_events", { maxResults: 3 }), new AIMessage("You have one meeting.")), { google });
    const { conversationId } = await service.chat(input);

    const view = await service.get("user-1", "jwt", conversationId);
    expect(view.messages).toEqual([
      { role: "user", text: "What is on my calendar?", tools: [] },
      { role: "assistant", text: "You have one meeting.", tools: ["list_events"] },
    ]);
    expect(JSON.stringify(view)).not.toContain("Secret meeting");
  });

  it("deletes a conversation, and says 'not found' for one that is not the caller's", async () => {
    const { service } = setup(model(new AIMessage("Hi")));
    const { conversationId } = await service.chat(input);
    await service.remove("user-1", "jwt", conversationId);
    expect(await service.list("user-1", "jwt")).toEqual([]);
    await expect(service.get("user-1", "jwt", conversationId)).rejects.toBeInstanceOf(ConversationNotFoundError);
    await expect(service.remove("user-1", "jwt", "someone-elses")).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe("titleFrom", () => {
  it("keeps a short message as it is, on one line", () => {
    expect(titleFrom("Plan my\nweek")).toBe("Plan my week");
  });

  it("cuts a long message at a word and marks the cut", () => {
    const title = titleFrom("Find every email from the recruiter at Contoso about the senior engineer role and draft a reply");
    expect(title.length).toBeLessThanOrEqual(63);
    expect(title.endsWith("...")).toBe(true);
    expect(title).toBe("Find every email from the recruiter at Contoso about the...");
  });

  it("cuts a long word in the middle when there is no space to cut at", () => {
    expect(titleFrom("x".repeat(80))).toBe(`${"x".repeat(60)}...`);
  });
});

describe("toViewMessages", () => {
  it("collects tools across several rounds into the answer that follows them", () => {
    const view = toViewMessages([
      { role: "user", content: "Busy?", toolCallId: null, toolCalls: null },
      { role: "assistant", content: "", toolCallId: null, toolCalls: [{ Id: "1", ToolName: "list_events", ArgumentsJson: "{}" }] },
      { role: "tool", content: "raw", toolCallId: "1", toolCalls: null },
      { role: "assistant", content: "", toolCallId: null, toolCalls: [{ Id: "2", ToolName: "list_tasks", ArgumentsJson: "{}" }, { Id: "3", ToolName: "list_events", ArgumentsJson: "{}" }] },
      { role: "tool", content: "raw", toolCallId: "2", toolCalls: null },
      { role: "tool", content: "raw", toolCallId: "3", toolCalls: null },
      { role: "assistant", content: "Fairly busy.", toolCallId: null, toolCalls: null },
      { role: "user", content: "Thanks", toolCallId: null, toolCalls: null },
      { role: "assistant", content: "Any time.", toolCallId: null, toolCalls: null },
    ]);
    expect(view).toEqual([
      { role: "user", text: "Busy?", tools: [] },
      { role: "assistant", text: "Fairly busy.", tools: ["list_events", "list_tasks"] },
      { role: "user", text: "Thanks", tools: [] },
      { role: "assistant", text: "Any time.", tools: [] },
    ]);
  });
});

// An in-memory stand-in for the proposed-changes table, with the same rules the real one has.
function memoryActions() {
  const rows = new Map<string, AgentAction>();
  const store: ActionStore = {
    async propose(a) {
      const id = `act-${rows.size + 1}`;
      rows.set(id, { id, conversationId: a.conversationId, tool: a.tool, args: a.args, preview: a.preview, status: "pending", result: null, expiresAt: "2026-11-18T12:00:00Z" });
      return { id, tool: a.tool, preview: a.preview };
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async claim(id) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return null;
      row.status = "running";
      return { ...row };
    },
    async finish(id, status, result) {
      Object.assign(rows.get(id)!, { status, result });
    },
    async reject(id) {
      const row = rows.get(id);
      if (!row || row.status !== "pending") return false;
      row.status = "rejected";
      return true;
    },
    async listPending(conversationId) {
      return [...rows.values()].filter((r) => r.conversationId === conversationId && r.status === "pending").map((r): PendingAction => ({ id: r.id, tool: r.tool, preview: r.preview }));
    },
  };
  return { store, rows };
}

function fakeTasks(overrides: Partial<TaskStore> = {}) {
  const created: unknown[] = [];
  const completed: string[] = [];
  const store: TaskStore = {
    list: async () => [],
    create: async (task) => (created.push(task), { id: "t-1" }),
    get: async (id) => (id === "00000000-0000-4000-8000-000000000001" ? { title: "Pay rent", dueDate: "2026-11-24" } : null),
    complete: async (id) => (completed.push(id), { title: "Pay rent", occurrenceDate: "2026-11-24" }),
    ...overrides,
  };
  return { store, created, completed };
}

describe("approval of changes", () => {
  const taskId = "00000000-0000-4000-8000-000000000001";

  it("proposes a change instead of making it, and returns the card", async () => {
    const tasks = fakeTasks();
    const actions = memoryActions();
    const { service, chatModel } = setup(model(toolCall("create_task", { title: "Pay rent", dueDate: "2026-11-24", priority: "high" }), new AIMessage("I proposed it.")), {
      openTasks: () => tasks.store,
      openActions: () => actions.store,
    });

    const result = await service.chat(input);

    expect(tasks.created).toEqual([]); // nothing was written
    expect(result.pendingActions).toEqual([{ id: "act-1", tool: "create_task", preview: 'Add the task "Pay rent" due 2026-11-24, high priority' }]);
    expect(actions.rows.get("act-1")).toMatchObject({ status: "pending", conversationId: "conv-1", args: { title: "Pay rent", dueDate: "2026-11-24", priority: "high" } });
    expect(systemPromptOf(chatModel)).toContain("approval");
  });

  it("runs reading tools straight away, with no card", async () => {
    const actions = memoryActions();
    const { service } = setup(model(toolCall("list_tasks", {}), new AIMessage("Nothing due.")), { openTasks: () => fakeTasks().store, openActions: () => actions.store });
    const result = await service.chat(input);
    expect(result.pendingActions).toEqual([]);
    expect(actions.rows.size).toBe(0);
  });

  it("names the task on a complete card, and refuses to propose for a task that does not exist", async () => {
    const actions = memoryActions();
    const { service } = setup(
      model(toolCall("complete_task", { taskId }, "c1"), toolCall("complete_task", { taskId: "00000000-0000-4000-8000-000000000002" }, "c2"), new AIMessage("ok")),
      { openTasks: () => fakeTasks().store, openActions: () => actions.store },
    );
    const result = await service.chat(input);
    expect(result.pendingActions.map((a) => a.preview)).toEqual(['Mark the task "Pay rent" done']);
    expect(actions.rows.size).toBe(1);
  });

  it("tells the model plainly when the proposal could not be saved, without the database's words", async () => {
    const actions = memoryActions();
    actions.store.propose = async () => {
      throw new Error("relation secret_table does not exist");
    };
    const { service, memory } = setup(model(toolCall("create_task", { title: "x", dueDate: "2026-11-24" }), new AIMessage("It failed.")), {
      openTasks: () => fakeTasks().store,
      openActions: () => actions.store,
    });
    await service.chat(input);
    const toolText = memory.rows.get("conv-1")!.find((m) => m.role === "tool")!.content;
    expect(toolText).toContain("could not be saved for approval");
    expect(toolText).not.toContain("secret_table");
  });

  it("makes the change only when the user approves, using the stored arguments", async () => {
    const tasks = fakeTasks();
    const actions = memoryActions();
    const { service } = setup(model(toolCall("create_task", { title: "Pay rent", dueDate: "2026-11-24" }), new AIMessage("Proposed.")), {
      openTasks: () => tasks.store,
      openActions: () => actions.store,
    });
    const { pendingActions } = await service.chat(input);

    const outcome = await service.approve("user-1", "jwt", pendingActions[0]!.id);

    expect(outcome).toEqual({ id: "act-1", status: "done", result: 'Created the task "Pay rent" due 2026-11-24 (id t-1).' });
    expect(tasks.created).toEqual([{ title: "Pay rent", dueDate: "2026-11-24", notes: undefined, priority: "none" }]);
    expect(actions.rows.get("act-1")).toMatchObject({ status: "done" });
  });

  it("will not run the same change twice, nor one that was rejected", async () => {
    const tasks = fakeTasks();
    const actions = memoryActions();
    const { service } = setup(model(toolCall("create_task", { title: "A", dueDate: "2026-11-24" }, "c1"), toolCall("create_task", { title: "B", dueDate: "2026-11-24" }, "c2"), new AIMessage("ok")), {
      openTasks: () => tasks.store,
      openActions: () => actions.store,
    });
    const { pendingActions } = await service.chat(input);

    await service.approve("user-1", "jwt", pendingActions[0]!.id);
    await expect(service.approve("user-1", "jwt", pendingActions[0]!.id)).rejects.toMatchObject({ status: "done" });
    expect(tasks.created).toHaveLength(1);

    await service.reject("user-1", "jwt", pendingActions[1]!.id);
    await expect(service.approve("user-1", "jwt", pendingActions[1]!.id)).rejects.toBeInstanceOf(ActionNotPendingError);
    await expect(service.reject("user-1", "jwt", pendingActions[1]!.id)).rejects.toMatchObject({ status: "rejected" });
    expect(tasks.created).toHaveLength(1);
  });

  it("says 'expired' for a pending change the store will not hand out any more", async () => {
    const actions = memoryActions();
    const { service } = setup(model(toolCall("create_task", { title: "A", dueDate: "2026-11-24" }), new AIMessage("ok")), { openTasks: () => fakeTasks().store, openActions: () => actions.store });
    const { pendingActions } = await service.chat(input);
    actions.store.claim = async () => null; // past its day
    await expect(service.approve("user-1", "jwt", pendingActions[0]!.id)).rejects.toMatchObject({ status: "expired" });
  });

  it("says 'not found' for an action that is not the caller's or does not exist", async () => {
    const { service } = setup(model(new AIMessage("x")), { openActions: () => memoryActions().store });
    await expect(service.approve("user-1", "jwt", "nope")).rejects.toBeInstanceOf(ActionNotFoundError);
    await expect(service.reject("user-1", "jwt", "nope")).rejects.toBeInstanceOf(ActionNotFoundError);
  });

  it("records a failed outcome when the change itself fails, with a plain message", async () => {
    const tasks = fakeTasks({ create: async () => Promise.reject(new Error("secret detail")) });
    const actions = memoryActions();
    const { service } = setup(model(toolCall("create_task", { title: "A", dueDate: "2026-11-24" }), new AIMessage("ok")), { openTasks: () => tasks.store, openActions: () => actions.store });
    const { pendingActions } = await service.chat(input);

    const outcome = await service.approve("user-1", "jwt", pendingActions[0]!.id);

    expect(outcome.status).toBe("failed");
    expect(outcome.result).not.toContain("secret detail");
    expect(actions.rows.get("act-1")).toMatchObject({ status: "failed" });
  });

  it("marks a task that has gone since the proposal as failed, not done", async () => {
    const tasks = fakeTasks();
    const actions = memoryActions();
    const { service } = setup(model(toolCall("complete_task", { taskId }), new AIMessage("ok")), { openTasks: () => tasks.store, openActions: () => actions.store });
    const { pendingActions } = await service.chat(input);
    tasks.store.complete = async () => null; // deleted in the meantime

    expect(await service.approve("user-1", "jwt", pendingActions[0]!.id)).toMatchObject({ status: "failed", result: "No task with that id was found." });
  });

  it("runs an approved Google change with the user's own Google token, and reports Google's refusal as failed", async () => {
    const google = fakeGoogle(200, { id: "draft-1" });
    const actions = memoryActions();
    const { service } = setup(model(toolCall("create_draft", { to: "a@example.com", subject: "Hi", body: "Hello" }), new AIMessage("Proposed.")), { google, openActions: () => actions.store });
    const { pendingActions } = await service.chat(input);
    expect(google.authHeaders).toEqual([]); // proposing touched nothing

    const outcome = await service.approve("user-1", "jwt", pendingActions[0]!.id);

    expect(outcome.status).toBe("done");
    expect(google.authHeaders).toEqual(["Bearer google-token"]);

    const refused = setup(model(toolCall("create_draft", { to: "a@example.com", subject: "Hi", body: "Hello" }), new AIMessage("ok")), { google: fakeGoogle(403, { error: "no" }), openActions: () => actions.store });
    const proposal = await refused.service.chat(input);
    expect(await refused.service.approve("user-1", "jwt", proposal.pendingActions[0]!.id)).toMatchObject({ status: "failed" });
  });

  it("shows pending cards again when the conversation is reopened, but not decided ones", async () => {
    const actions = memoryActions();
    const { service } = setup(model(toolCall("create_task", { title: "A", dueDate: "2026-11-24" }, "c1"), toolCall("create_task", { title: "B", dueDate: "2026-11-24" }, "c2"), new AIMessage("ok")), {
      openTasks: () => fakeTasks().store,
      openActions: () => actions.store,
    });
    const { conversationId, pendingActions } = await service.chat(input);
    await service.reject("user-1", "jwt", pendingActions[0]!.id);

    expect((await service.get("user-1", "jwt", conversationId)).pendingActions.map((a) => a.id)).toEqual([pendingActions[1]!.id]);
  });
});
