// Saves and loads chat conversations as the signed-in user. The Supabase client is built with the
// user's own token, so row-level security decides what they can see: another user's conversation
// is simply invisible, and the database rejects an insert whose user_id is not the caller's.
import type { SupabaseClient } from "@supabase/supabase-js";
import { rowToMessage, type MessageRow, type StoredMessage } from "./messageMapper.js";
import type { BaseMessage } from "@langchain/core/messages";

// The conversation does not exist or belongs to someone else (the two look the same on purpose).
export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
  }
}

export interface ConversationStore {
  // Returns the id of the existing conversation, or creates a new one when no id is given.
  ensureConversation(conversationId?: string): Promise<string>;
  loadMessages(conversationId: string): Promise<BaseMessage[]>;
  appendMessages(conversationId: string, messages: StoredMessage[]): Promise<void>;
}

export function createSupabaseConversationStore(client: SupabaseClient, userId: string): ConversationStore {
  return {
    async ensureConversation(conversationId) {
      if (conversationId) {
        const { data, error } = await client.from("conversations").select("id").eq("id", conversationId).maybeSingle();
        if (error) throw new Error(`Could not read the conversation (${error.code ?? "unknown"})`);
        if (!data) throw new ConversationNotFoundError();
        return data.id as string;
      }
      const { data, error } = await client.from("conversations").insert({ user_id: userId }).select("id").single();
      if (error) throw new Error(`Could not create the conversation (${error.code ?? "unknown"})`);
      return data.id as string;
    },

    async loadMessages(conversationId) {
      const { data, error } = await client
        .from("messages")
        .select("role, content, tool_call_id, tool_calls")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      if (error) throw new Error(`Could not read messages (${error.code ?? "unknown"})`);
      return (data as MessageRow[]).map(rowToMessage);
    },

    async appendMessages(conversationId, messages) {
      if (messages.length === 0) return;
      // One insert = one statement, so either every message of the turn is saved or none is.
      // A batch insert gives every row the same now(), which would lose the order, so each row
      // gets its own timestamp, one millisecond apart.
      const start = Date.now();
      const rows = messages.map((m, i) => ({
        conversation_id: conversationId,
        role: m.role,
        content: m.content,
        tool_call_id: m.toolCallId,
        tool_calls: m.toolCalls,
        created_at: new Date(start + i).toISOString(),
      }));
      const { error } = await client.from("messages").insert(rows);
      if (error) throw new Error(`Could not save messages (${error.code ?? "unknown"})`);
    },
  };
}
