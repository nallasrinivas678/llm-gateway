import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../config.js";
import type { FetchFn } from "../google-mcp/common.js";
import { GoogleReconnectRequired } from "../google-tokens/tokenService.js";
import { createChatService, TOO_MANY_STEPS_REPLY } from "./chatService.js";
import { ConversationNotFoundError, type ConversationStore } from "./conversationStore.js";
import { rowToMessage, type StoredMessage } from "./messageMapper.js";

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
  const conversations = new Set<string>();
  const rows = new Map<string, StoredMessage[]>();
  const store: ConversationStore = {
    async ensureConversation(id) {
      if (!id) {
        const created = `conv-${conversations.size + 1}`;
        conversations.add(created);
        return created;
      }
      if (!conversations.has(id)) throw new ConversationNotFoundError();
      return id;
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
  options: { google?: ReturnType<typeof fakeGoogle>; token?: () => Promise<string>; maxToolRounds?: number; chat?: Partial<typeof settings.chat> } = {},
) {
  const memory = memoryStore();
  const google = options.google ?? fakeGoogle();
  const service = createChatService({
    model: chatModel,
    settings: { ...settings, chat: { ...settings.chat, maxToolRounds: options.maxToolRounds ?? settings.chat.maxToolRounds, ...options.chat } },
    getGoogleToken: options.token ?? (async () => "google-token"),
    openStore: () => memory.store,
    googleFetch: google.googleFetch,
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

    expect(result).toEqual({ conversationId: "conv-1", reply: "Hello there!", toolCallsExecuted: [] });
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
