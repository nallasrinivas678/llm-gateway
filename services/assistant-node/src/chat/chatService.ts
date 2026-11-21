import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { GraphRecursionError } from "@langchain/langgraph";
import { createAgent } from "langchain";
import type { Settings } from "../config.js";
import { createGoogleMcpServer } from "../google-mcp/server.js";
import type { FetchFn } from "../google-mcp/common.js";
import { GoogleReconnectRequired } from "../google-tokens/tokenService.js";
import { logError } from "../log.js";
import type { ActionStore, PendingAction } from "./actionStore.js";
import { ActionNotFoundError, ActionNotPendingError, isFailureText, previewFor, withApproval } from "./approval.js";
import type { ConversationStore } from "./conversationStore.js";
import { messageToStored, messagesToStored, type StoredMessage } from "./messageMapper.js";
import { trimHistory } from "./history.js";
import { loadMcpTools } from "./mcpTools.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { taskTools, type TaskStore } from "./taskTools.js";
import { webSearchTool, type WebSearchFn } from "./webSearch.js";

export const TOO_MANY_STEPS_REPLY =
  "I couldn't finish that request. Please try a simpler request, or break it into smaller steps.";
const EMPTY_REPLY = "I wasn't able to put together a reply. Please try again.";

export interface ChatDeps {
  model: BaseChatModel;
  settings: Settings;
  getGoogleToken: (userId: string) => Promise<string>;
  openStore: (userId: string, jwt: string) => ConversationStore;
  googleFetch?: FetchFn;
  // When given, the model also gets a web_search tool.
  webSearch?: WebSearchFn;
  // When given, the model also gets the user's TaskTide task tools.
  openTasks?: (userId: string, jwt: string) => TaskStore;
  // When given, a tool that changes something only proposes the change; the user approves it.
  openActions?: (userId: string, jwt: string) => ActionStore;
  now?: () => Date;
}

export interface ChatInput {
  userId: string;
  jwt: string;
  conversationId?: string;
  message: string;
}

// Same shape the .NET POST /assistant/chat returns.
export interface ChatResult {
  conversationId: string;
  reply: string;
  toolCallsExecuted: string[];
  // Changes the assistant proposed in this turn, waiting for the user's approval.
  pendingActions: PendingAction[];
}

export interface ActionOutcome {
  id: string;
  status: "done" | "failed" | "rejected";
  result: string | null;
}

// A saved message as the chat page shows it: what the user said, and each final answer with the
// tools used for it. Tool calls and raw tool output stay on the server.
export interface ViewMessage {
  role: "user" | "assistant";
  text: string;
  tools: string[];
}

export interface ConversationView {
  id: string;
  title: string | null;
  messages: ViewMessage[];
  // Proposed changes still waiting, so reopening the conversation shows the cards again.
  pendingActions: PendingAction[];
}

const TITLE_MAX_CHARS = 60;
const LIST_LIMIT = 50;

// The first message, on one line and cut at a word, so the list needs no extra model call.
export function titleFrom(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_MAX_CHARS) return line;
  const cut = line.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > TITLE_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function toViewMessages(stored: StoredMessage[]): ViewMessage[] {
  const view: ViewMessage[] = [];
  let tools: string[] = [];
  for (const m of stored) {
    if (m.role === "user") {
      view.push({ role: "user", text: m.content, tools: [] });
      tools = [];
    } else if (m.role === "assistant") {
      for (const call of m.toolCalls ?? []) if (!tools.includes(call.ToolName)) tools.push(call.ToolName);
      // An assistant message that only asks for tools has no text for the user.
      if (m.content.trim()) {
        view.push({ role: "assistant", text: m.content, tools });
        tools = [];
      }
    }
  }
  return view;
}

export function createChatService(deps: ChatDeps) {
  const now = deps.now ?? (() => new Date());

  // Connects the Google tool server to a client in memory (no network hop). The server is built
  // with this user's token, so the tools can only ever act on this user's account.
  async function connectGoogleTools(googleToken: string) {
    const server = createGoogleMcpServer(googleToken, { fetch: deps.googleFetch, settings: deps.settings.google });
    const client = new Client({ name: "assistant-node", version: "0.1.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const tools = await loadMcpTools(client, { toolTimeoutMs: deps.settings.chat.toolTimeoutSeconds * 1000 });
    return { tools, close: () => client.close() };
  }

  // Finds the real tool (not the proposing one) and runs it with the stored arguments. The tool
  // checks the arguments again, so a task that has gone since the proposal gives a clear answer.
  async function runApproved(userId: string, jwt: string, toolName: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    let google: Awaited<ReturnType<typeof connectGoogleTools>> | null = null;
    try {
      const own = deps.openTasks ? taskTools(deps.openTasks(userId, jwt)) : [];
      let tools = own;
      if (!own.some((t) => t.name === toolName)) {
        google = await connectGoogleTools(await deps.getGoogleToken(userId));
        tools = google.tools;
      }
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) return { ok: false, text: "That change is no longer supported." };
      const text = String(await tool.invoke(args));
      return { ok: !isFailureText(text), text };
    } catch (error) {
      if (error instanceof GoogleReconnectRequired) return { ok: false, text: "Google needs to be connected again. Reconnect it, then ask again." };
      logError("running an approved action failed", error);
      return { ok: false, text: "The change could not be made." };
    } finally {
      await google?.close();
    }
  }

  return {
    async chat(input: ChatInput): Promise<ChatResult> {
      const store = deps.openStore(input.userId, input.jwt);
      const conversationId = await store.ensureConversation(input.conversationId, input.conversationId ? undefined : titleFrom(input.message));
      // Only the recent part goes to the model; the whole conversation stays saved.
      const history = trimHistory(await store.loadMessages(conversationId), deps.settings.chat.maxHistoryMessages);

      // Not connected to Google (or access revoked): still chat, but without the Google tools,
      // and let the model say so. Any other failure is a real error and is passed up.
      let google: Awaited<ReturnType<typeof connectGoogleTools>> | null = null;
      try {
        google = await connectGoogleTools(await deps.getGoogleToken(input.userId));
      } catch (error) {
        if (!(error instanceof GoogleReconnectRequired)) throw error;
      }

      try {
        const tasks = deps.openTasks?.(input.userId, input.jwt);
        const actions = deps.openActions?.(input.userId, input.jwt);
        const pendingActions: PendingAction[] = [];
        const allTools = [...(google?.tools ?? []), ...(deps.webSearch ? [webSearchTool(deps.webSearch)] : []), ...(tasks ? taskTools(tasks) : [])];
        const agent = createAgent({
          model: deps.model,
          // With approval on, a tool that changes something saves a proposal instead of running.
          tools: actions
            ? withApproval(allTools, {
                describe: async (tool, args) => {
                  if (tool !== "complete_task") return { preview: previewFor(tool, args) };
                  const task = tasks ? await tasks.get(String(args.taskId)) : null;
                  return task ? { preview: previewFor(tool, args, task.title) } : { refusal: "No task with that id was found." };
                },
                propose: (tool, args, preview) => actions.propose({ conversationId, tool, args, preview }),
                onProposed: (action) => pendingActions.push(action),
              })
            : allTools,
          systemPrompt: buildSystemPrompt({
            today: now().toISOString().slice(0, 10),
            googleConnected: google !== null,
            webSearch: deps.webSearch !== undefined,
            tasks: deps.openTasks !== undefined,
            approval: actions !== undefined,
          }),
        });

        const userMessage = new HumanMessage(input.message);
        let produced: BaseMessage[];
        try {
          // Each tool round is two graph steps (model, then tools); +1 for the final answer.
          const result = await agent.invoke(
            { messages: [...history, userMessage] },
            { recursionLimit: deps.settings.chat.maxToolRounds * 2 + 1, signal: AbortSignal.timeout(deps.settings.chat.runTimeoutSeconds * 1000) },
          );
          produced = (result.messages as BaseMessage[]).slice(history.length);
        } catch (error) {
          if (!(error instanceof GraphRecursionError)) throw error;
          // Keep the question and the apology; the half-finished tool calls are dropped.
          produced = [userMessage, new AIMessage(TOO_MANY_STEPS_REPLY)];
        }

        const stored = messagesToStored(produced);
        await store.appendMessages(conversationId, stored);

        const last = [...produced].reverse().find((m) => m instanceof AIMessage);
        const reply = (last ? messageToStored(last)?.content : "")?.trim() || EMPTY_REPLY;
        const toolCallsExecuted = [...new Set(stored.flatMap((m) => m.toolCalls?.map((c) => c.ToolName) ?? []))];
        return { conversationId, reply, toolCallsExecuted, pendingActions };
      } finally {
        await google?.close();
      }
    },

    async list(userId: string, jwt: string) {
      return deps.openStore(userId, jwt).listConversations(LIST_LIMIT);
    },

    async get(userId: string, jwt: string, conversationId: string): Promise<ConversationView> {
      const store = deps.openStore(userId, jwt);
      const { id, title } = await store.getConversation(conversationId);
      const pendingActions = (await deps.openActions?.(userId, jwt).listPending(id)) ?? [];
      return { id, title, messages: toViewMessages(messagesToStored(await store.loadMessages(id))), pendingActions };
    },

    // Runs a proposed change as the user: the stored arguments, through the real tool. The action is
    // claimed first with one conditional update, so a double click cannot run it twice.
    async approve(userId: string, jwt: string, actionId: string): Promise<ActionOutcome> {
      const actions = deps.openActions?.(userId, jwt);
      if (!actions) throw new ActionNotFoundError();
      const found = await actions.get(actionId);
      if (!found) throw new ActionNotFoundError();
      const action = await actions.claim(actionId);
      if (!action) throw new ActionNotPendingError(found.status === "pending" ? "expired" : found.status);

      const { ok, text } = await runApproved(userId, jwt, action.tool, action.args);
      const status = ok ? "done" : "failed";
      try {
        await actions.finish(actionId, status, text);
      } catch (error) {
        // The change was made (or not); only the record failed. The user still gets the outcome.
        logError("recording an action outcome failed", error);
      }
      return { id: actionId, status, result: text };
    },

    async reject(userId: string, jwt: string, actionId: string): Promise<ActionOutcome> {
      const actions = deps.openActions?.(userId, jwt);
      if (!actions) throw new ActionNotFoundError();
      if (!(await actions.reject(actionId))) {
        const found = await actions.get(actionId);
        if (!found) throw new ActionNotFoundError();
        throw new ActionNotPendingError(found.status);
      }
      return { id: actionId, status: "rejected", result: null };
    },

    async remove(userId: string, jwt: string, conversationId: string) {
      await deps.openStore(userId, jwt).deleteConversation(conversationId);
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
