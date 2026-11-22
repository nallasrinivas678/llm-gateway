import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { GraphRecursionError } from "@langchain/langgraph";
import { createAgent } from "langchain";
import type { Settings } from "../config.js";
import { createGoogleMcpServer } from "../google-mcp/server.js";
import { writeProblem } from "../google-mcp/writeChecks.js";
import type { FetchFn } from "../google-mcp/common.js";
import { GoogleReconnectRequired } from "../google-tokens/tokenService.js";
import { logError } from "../log.js";
import type { ActionStore, PendingAction } from "./actionStore.js";
import { ActionNotFoundError, ActionNotPendingError, WRITE_TOOLS, isFailureText, previewFor, withApproval } from "./approval.js";
import { calculatorTool } from "./calculatorTool.js";
import { documentTools, type DocumentAccess } from "./documentTools.js";
import { withScan } from "./injectionScan.js";
import { localTime, validTimeZone } from "./localTime.js";
import { profileProblem, profileTool, type Profile, type ProfileStore } from "./profileTool.js";
import type { ConversationStore } from "./conversationStore.js";
import { messageToStored, messagesToStored, type StoredMessage } from "./messageMapper.js";
import { trimHistory } from "./history.js";
import { loadMcpTools } from "./mcpTools.js";
import { outcomeOf, withTiming, type RecordedToolCall, type RunOutcome, type RunStore } from "./runRecord.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { taskTools, type TaskStore } from "./taskTools.js";
import { webSearchTool, type WebSearchFn } from "./webSearch.js";
import { weatherTool, type WeatherFn } from "./weatherTool.js";

const WRAP_UP =
  "You have used all the research steps you are allowed. Using only what you have found so far, write the answer now: a short answer, then the sources you used, and say what you could not confirm. Do not call any tools.";

// The messages up to the last finished tool round: a model message that asked for tools whose answers
// never came cannot be sent to the model again.
export function completedPrefix(messages: BaseMessage[]): BaseMessage[] {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1];
    if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0) end--;
    else break;
  }
  return messages.slice(0, end);
}

// One model call, without tools, that turns the research done so far into an answer. Null when it fails.
async function answerFromProgress(model: BaseChatModel, systemPrompt: string, latest: BaseMessage[], timeoutSeconds: number): Promise<AIMessage | null> {
  try {
    const answer = await model.invoke([new SystemMessage(systemPrompt), ...completedPrefix(latest), new HumanMessage(WRAP_UP)], {
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    return answer instanceof AIMessage ? answer : new AIMessage(String(answer.content));
  } catch (error) {
    logError("the research wrap-up failed", error);
    return null;
  }
}

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
  // When given, the model also gets get_weather (the forecast for a place).
  weather?: WeatherFn;
  // When given, the model also gets the user's uploaded PDFs as list_documents and ask_document.
  openDocuments?: (userId: string, jwt: string) => DocumentAccess;
  // When given, what the user asked the assistant to remember goes into the prompt, and save_profile exists.
  openProfile?: (userId: string, jwt: string) => ProfileStore;
  // When given, a tool that changes something only proposes the change; the user approves it.
  openActions?: (userId: string, jwt: string) => ActionStore;
  // When given, each turn leaves a record of its timing and outcome (no message text).
  openRuns?: (userId: string, jwt: string) => RunStore;
  now?: () => Date;
}

export interface ChatInput {
  userId: string;
  jwt: string;
  conversationId?: string;
  message: string;
  // The browser's IANA time zone (for example America/Los_Angeles); ignored when it is not a real one.
  timeZone?: string;
  // "research": reading tools only, more steps and time, and an answer with sources.
  mode?: "chat" | "research";
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
      const own = [...(deps.openTasks ? taskTools(deps.openTasks(userId, jwt)) : []), ...(deps.openProfile ? [profileTool(deps.openProfile(userId, jwt))] : [])];
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
      const research = input.mode === "research";
      const limits = research ? deps.settings.chat.research : deps.settings.chat;

      // What the user asked to be remembered. A failure here must not stop the chat.
      const profileStore = deps.openProfile?.(input.userId, input.jwt);
      let profile: Profile | null = null;
      try {
        profile = (await profileStore?.get()) ?? null;
      } catch (error) {
        logError("reading the profile failed", error);
      }
      // The profile's time zone wins over the browser's; with neither the model gets the UTC date.
      const zone = validTimeZone(profile?.timeZone) ?? validTimeZone(input.timeZone);
      const local = zone ? localTime(now(), zone) : undefined;

      // Not connected to Google (or access revoked): still chat, but without the Google tools,
      // and let the model say so. Any other failure is a real error and is passed up.
      let google: Awaited<ReturnType<typeof connectGoogleTools>> | null = null;
      try {
        google = await connectGoogleTools(await deps.getGoogleToken(input.userId));
      } catch (error) {
        if (!(error instanceof GoogleReconnectRequired)) throw error;
      }

      // What the run record keeps: timing and outcome only, never message text or tool arguments.
      const runs = deps.openRuns?.(input.userId, input.jwt);
      const runStarted = performance.now();
      const startedAt = now().toISOString();
      const toolCalls: RecordedToolCall[] = [];
      const pendingActions: PendingAction[] = [];
      let outcome: RunOutcome = "ok";
      let steps = 0;

      try {
        const tasks = deps.openTasks?.(input.userId, input.jwt);
        const actions = deps.openActions?.(input.userId, input.jwt);
        const docs = deps.openDocuments?.(input.userId, input.jwt);
        const everyTool = [
          ...(google?.tools ?? []),
          ...(deps.webSearch ? [webSearchTool(deps.webSearch)] : []),
          ...(docs ? documentTools(docs) : []),
          ...(deps.weather ? [weatherTool(deps.weather, deps.settings.chat.weather.maxDays)] : []),
          calculatorTool(),
          ...(tasks ? taskTools(tasks) : []),
          ...(profileStore ? [profileTool(profileStore)] : []),
        ];
        // Research mode only reads: nothing that changes something is offered, so there are no cards.
        const allTools = withScan(research ? everyTool.filter((tool) => !WRITE_TOOLS.has(tool.name)) : everyTool, isFailureText);
        const approvalOn = actions !== undefined && !research;
        const systemPrompt = buildSystemPrompt({
          today: now().toISOString().slice(0, 10),
          googleConnected: google !== null,
          local,
          profile: profile ?? undefined,
          webSearch: deps.webSearch !== undefined,
          tasks: deps.openTasks !== undefined,
          approval: approvalOn,
          documents: docs !== undefined,
          weather: deps.weather !== undefined,
          calculator: true,
          profileTool: profileStore !== undefined && !research,
          research,
        });
        const agent = createAgent({
          model: deps.model,
          // With approval on, a tool that changes something saves a proposal instead of running.
          tools: withTiming(
            actions && approvalOn
            ? withApproval(allTools, {
                describe: async (tool, args) => {
                  // A call that could never work is refused now, so a card is never shown for it.
                  const problem = tool === "save_profile" ? profileProblem(args) : writeProblem(tool, args, deps.settings.google);
                  if (problem) return { refusal: `Nothing was proposed because the input is not valid (${problem}). Correct it, or ask the user.` };
                  if (tool !== "complete_task") return { preview: previewFor(tool, args) };
                  const task = tasks ? await tasks.get(String(args.taskId)) : null;
                  return task ? { preview: previewFor(tool, args, task.title) } : { refusal: "No task with that id was found." };
                },
                propose: (tool, args, preview) => actions.propose({ conversationId, tool, args, preview }),
                onProposed: (action) => pendingActions.push(action),
              })
            : allTools,
            toolCalls,
          ),
          systemPrompt,
        });

        const userMessage = new HumanMessage(input.message);
        let produced: BaseMessage[];
        // Each tool round is two graph steps (model, then tools); +1 for the final answer.
        const config = { recursionLimit: limits.maxToolRounds * 2 + 1, signal: AbortSignal.timeout(limits.runTimeoutSeconds * 1000) };
        let latest: BaseMessage[] = [...history, userMessage];
        try {
          if (research) {
            // Keep the latest state as the run goes, so that at the step limit what was found is not lost.
            const states = await agent.stream({ messages: latest }, { ...config, streamMode: "values" });
            for await (const state of states) latest = state.messages as BaseMessage[];
            produced = latest.slice(history.length);
          } else {
            const result = await agent.invoke({ messages: latest }, config);
            produced = (result.messages as BaseMessage[]).slice(history.length);
          }
          steps = produced.filter((m) => m instanceof AIMessage).length;
        } catch (error) {
          if (!(error instanceof GraphRecursionError)) throw error;
          outcome = "step_limit";
          steps = limits.maxToolRounds + 1;
          // Research: one last call with no tools, to answer from what was found so far. Otherwise, or if
          // that fails, keep the question and the apology; the half-finished tool calls are dropped.
          const answered = research ? await answerFromProgress(deps.model, systemPrompt, latest, deps.settings.chat.toolTimeoutSeconds) : null;
          produced = answered ? [...completedPrefix(latest).slice(history.length), answered] : [userMessage, new AIMessage(TOO_MANY_STEPS_REPLY)];
        }

        const stored = messagesToStored(produced);
        await store.appendMessages(conversationId, stored);

        const last = [...produced].reverse().find((m) => m instanceof AIMessage);
        const reply = (last ? messageToStored(last)?.content : "")?.trim() || EMPTY_REPLY;
        const toolCallsExecuted = [...new Set(stored.flatMap((m) => m.toolCalls?.map((c) => c.ToolName) ?? []))];
        return { conversationId, reply, toolCallsExecuted, pendingActions };
      } catch (error) {
        // A time limit or any other failure; the step limit is handled above and is not an error.
        if (outcome === "ok") outcome = outcomeOf(error);
        throw error;
      } finally {
        // Recording must never break or slow the answer: a failure here is only logged.
        if (runs) {
          try {
            await runs.record({
              conversationId,
              startedAt,
              durationMs: performance.now() - runStarted,
              model: deps.settings.chat.model,
              steps,
              toolCalls,
              outcome,
              actionsProposed: pendingActions.length,
            });
          } catch (error) {
            logError("recording a run failed", error);
          }
        }
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
