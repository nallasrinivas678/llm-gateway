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

export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationStore {
  // Returns the id of the existing conversation, or creates a new one (with this title) when no id is given.
  ensureConversation(conversationId?: string, title?: string): Promise<string>;
  loadMessages(conversationId: string): Promise<BaseMessage[]>;
  // Saves a turn and moves the conversation to the top of the list.
  appendMessages(conversationId: string, messages: StoredMessage[]): Promise<void>;
  // The caller's conversations, most recently used first.
  listConversations(limit: number): Promise<ConversationSummary[]>;
  getConversation(conversationId: string): Promise<ConversationSummary>;
  // Its messages go with it (the foreign key cascades).
  deleteConversation(conversationId: string): Promise<void>;
}

interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

const toSummary = (row: ConversationRow): ConversationSummary => ({ id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at });
const failure = (what: string, error: { code?: string }) => new Error(`Could not ${what} (${error.code ?? "unknown"})`);

export function createSupabaseConversationStore(client: SupabaseClient, userId: string): ConversationStore {
  return {
    async ensureConversation(conversationId, title) {
      if (conversationId) {
        const { data, error } = await client.from("conversations").select("id").eq("id", conversationId).maybeSingle();
        if (error) throw failure("read the conversation", error);
        if (!data) throw new ConversationNotFoundError();
        return data.id as string;
      }
      const { data, error } = await client
        .from("conversations")
        .insert({ user_id: userId, title: title ?? null })
        .select("id")
        .single();
      if (error) throw failure("create the conversation", error);
      return data.id as string;
    },

    async loadMessages(conversationId) {
      const { data, error } = await client
        .from("messages")
        .select("role, content, tool_call_id, tool_calls")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      if (error) throw failure("read messages", error);
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
      if (error) throw failure("save messages", error);
      // The table has no trigger for this. A failure here only affects the list order, so the
      // saved turn is not undone for it.
      const touched = await client.from("conversations").update({ updated_at: new Date(start).toISOString() }).eq("id", conversationId);
      if (touched.error) throw failure("update the conversation", touched.error);
    },

    async listConversations(limit) {
      const { data, error } = await client
        .from("conversations")
        .select("id, title, created_at, updated_at")
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (error) throw failure("list conversations", error);
      return (data as ConversationRow[]).map(toSummary);
    },

    async getConversation(conversationId) {
      const { data, error } = await client.from("conversations").select("id, title, created_at, updated_at").eq("id", conversationId).maybeSingle();
      if (error) throw failure("read the conversation", error);
      if (!data) throw new ConversationNotFoundError();
      return toSummary(data as ConversationRow);
    },

    async deleteConversation(conversationId) {
      // Row-level security limits the delete to the caller's own rows; asking for the deleted ids
      // tells a missing (or someone else's) conversation apart from a deleted one.
      const { data, error } = await client.from("conversations").delete().eq("id", conversationId).select("id");
      if (error) throw failure("delete the conversation", error);
      if (!data || data.length === 0) throw new ConversationNotFoundError();
    },
  };
}
