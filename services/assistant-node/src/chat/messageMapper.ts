// Converts between the rows in the `messages` table and LangChain messages.
//
// The row format is the one the .NET service already writes, so a conversation can be continued
// by either service (this keeps rollback possible): role is user | assistant | tool, and tool_calls
// is a JSON array of { Id, ToolName, ArgumentsJson } with PascalCase keys and the arguments kept as
// a JSON string. Reading accepts camelCase too, in case another writer used it.
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

export interface StoredToolCall {
  Id: string;
  ToolName: string;
  ArgumentsJson: string;
}

export interface StoredMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId: string | null;
  toolCalls: StoredToolCall[] | null;
}

// A row as it comes back from Supabase.
export interface MessageRow {
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: unknown;
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

function readToolCalls(raw: unknown): StoredToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      Id: asString(e.Id ?? e.id),
      ToolName: asString(e.ToolName ?? e.toolName),
      ArgumentsJson: asString(e.ArgumentsJson ?? e.argumentsJson) || "{}",
    };
  });
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function rowToMessage(row: MessageRow): BaseMessage {
  switch (row.role) {
    case "user":
      return new HumanMessage(row.content);
    case "assistant": {
      const calls = readToolCalls(row.tool_calls);
      return new AIMessage({
        content: row.content,
        tool_calls: calls.map((c) => ({ id: c.Id, name: c.ToolName, args: parseArgs(c.ArgumentsJson), type: "tool_call" as const })),
      });
    }
    case "tool":
      return new ToolMessage({ content: row.content, tool_call_id: row.tool_call_id ?? "" });
    default:
      throw new Error(`Unknown message role in the database: ${row.role}`);
  }
}

// Message content is a string, or a list of blocks (text, images, ...). Only the text is kept.
function textOf(message: BaseMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  return content
    .map((block) => (typeof block === "object" && block !== null && "text" in block ? asString((block as { text?: unknown }).text) : ""))
    .join("");
}

// System messages are not stored: the system prompt is rebuilt on every request.
export function messageToStored(message: BaseMessage): StoredMessage | null {
  if (message instanceof HumanMessage) {
    return { role: "user", content: textOf(message), toolCallId: null, toolCalls: null };
  }
  if (message instanceof AIMessage) {
    const calls = (message.tool_calls ?? []).map((c) => ({ Id: c.id ?? "", ToolName: c.name, ArgumentsJson: JSON.stringify(c.args ?? {}) }));
    return { role: "assistant", content: textOf(message), toolCallId: null, toolCalls: calls.length > 0 ? calls : null };
  }
  if (message instanceof ToolMessage) {
    return { role: "tool", content: textOf(message), toolCallId: message.tool_call_id, toolCalls: null };
  }
  return null;
}

export function messagesToStored(messages: BaseMessage[]): StoredMessage[] {
  return messages.flatMap((m) => {
    const stored = messageToStored(m);
    return stored ? [stored] : [];
  });
}
