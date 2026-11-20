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
import type { ConversationStore } from "./conversationStore.js";
import { messageToStored, messagesToStored } from "./messageMapper.js";
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

  return {
    async chat(input: ChatInput): Promise<ChatResult> {
      const store = deps.openStore(input.userId, input.jwt);
      const conversationId = await store.ensureConversation(input.conversationId);
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
        const agent = createAgent({
          model: deps.model,
          tools: [...(google?.tools ?? []), ...(deps.webSearch ? [webSearchTool(deps.webSearch)] : []), ...(deps.openTasks ? taskTools(deps.openTasks(input.userId, input.jwt)) : [])],
          systemPrompt: buildSystemPrompt({ today: now().toISOString().slice(0, 10), googleConnected: google !== null, webSearch: deps.webSearch !== undefined, tasks: deps.openTasks !== undefined }),
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
        return { conversationId, reply, toolCallsExecuted };
      } finally {
        await google?.close();
      }
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;
