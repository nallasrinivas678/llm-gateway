// Changes the assistant proposed and the user has not decided on yet (table agent_actions). A write
// tool saves a row here instead of running; approving runs exactly the stored arguments. Read and
// written as the signed-in user, so row-level security keeps each user to their own rows.
import type { SupabaseClient } from "@supabase/supabase-js";

export type ActionStatus = "pending" | "running" | "done" | "failed" | "rejected";

export interface AgentAction {
  id: string;
  conversationId: string;
  tool: string;
  args: Record<string, unknown>;
  preview: string;
  status: ActionStatus;
  result: string | null;
  expiresAt: string;
}

// What the page shows on an approval card.
export interface PendingAction {
  id: string;
  tool: string;
  preview: string;
}

export interface ActionStore {
  propose(action: { conversationId: string; tool: string; args: Record<string, unknown>; preview: string }): Promise<PendingAction>;
  get(id: string): Promise<AgentAction | null>;
  // Takes a pending, unexpired action for running. Null when it is not pending any more (someone
  // else got there first, it was rejected, or it expired). The single conditional update is what
  // stops a double click from running the same action twice.
  claim(id: string): Promise<AgentAction | null>;
  finish(id: string, status: "done" | "failed", result: string): Promise<void>;
  // True when it was pending and is now rejected.
  reject(id: string): Promise<boolean>;
  listPending(conversationId: string): Promise<PendingAction[]>;
}

interface Row {
  id: string;
  conversation_id: string;
  tool: string;
  args: Record<string, unknown>;
  preview: string;
  status: ActionStatus;
  result: string | null;
  expires_at: string;
}

const COLUMNS = "id, conversation_id, tool, args, preview, status, result, expires_at";
const MAX_RESULT_CHARS = 500;
const fail = (what: string, error: { code?: string }) => new Error(`Could not ${what} (${error.code ?? "unknown"})`);

const toAction = (row: Row): AgentAction => ({
  id: row.id,
  conversationId: row.conversation_id,
  tool: row.tool,
  args: row.args,
  preview: row.preview,
  status: row.status,
  result: row.result,
  expiresAt: row.expires_at,
});

export function createSupabaseActionStore(client: SupabaseClient, userId: string, now: () => Date = () => new Date()): ActionStore {
  return {
    async propose({ conversationId, tool, args, preview }) {
      const { data, error } = await client
        .from("agent_actions")
        .insert({ user_id: userId, conversation_id: conversationId, tool, args, preview: preview.slice(0, 500) })
        .select("id")
        .single();
      if (error) throw fail("save the proposed change", error);
      return { id: data.id as string, tool, preview };
    },

    async get(id) {
      const { data, error } = await client.from("agent_actions").select(COLUMNS).eq("id", id).maybeSingle();
      if (error) throw fail("read the proposed change", error);
      return data ? toAction(data as Row) : null;
    },

    async claim(id) {
      const { data, error } = await client
        .from("agent_actions")
        .update({ status: "running", decided_at: now().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .gt("expires_at", now().toISOString())
        .select(COLUMNS);
      if (error) throw fail("approve the proposed change", error);
      return data && data.length > 0 ? toAction(data[0] as Row) : null;
    },

    async finish(id, status, result) {
      const { error } = await client.from("agent_actions").update({ status, result: result.slice(0, MAX_RESULT_CHARS) }).eq("id", id);
      if (error) throw fail("record the outcome", error);
    },

    async reject(id) {
      const { data, error } = await client
        .from("agent_actions")
        .update({ status: "rejected", decided_at: now().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .select("id");
      if (error) throw fail("reject the proposed change", error);
      return (data?.length ?? 0) > 0;
    },

    async listPending(conversationId) {
      const { data, error } = await client
        .from("agent_actions")
        .select("id, tool, preview")
        .eq("conversation_id", conversationId)
        .eq("status", "pending")
        .gt("expires_at", now().toISOString())
        .order("created_at", { ascending: true });
      if (error) throw fail("read the proposed changes", error);
      return (data ?? []) as PendingAction[];
    },
  };
}
