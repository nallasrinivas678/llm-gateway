// Reads and writes PDF Q&A data as the signed-in user. The Supabase client carries the user's own
// token, so row-level security and the storage policies decide what they can reach.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ChunkRow {
  chunkIndex: number;
  page: number;
  content: string;
  embedding: number[];
}

export interface RetrievedChunk {
  page: number;
  content: string;
  similarity: number;
}

export interface AskSource {
  page: number;
  snippet: string;
}

export interface DocStore {
  // Marks the document "processing" and returns its storage path; null when it is not the caller's.
  begin(documentId: string): Promise<string | null>;
  // The document's status, or null when it is not the caller's.
  status(documentId: string): Promise<string | null>;
  download(storagePath: string): Promise<Uint8Array>;
  // Replaces the document's chunks and marks it ready.
  replaceChunks(documentId: string, chunks: ChunkRow[], pageCount: number): Promise<void>;
  fail(documentId: string, message: string): Promise<void>;
  match(documentId: string, embedding: number[], count: number): Promise<RetrievedChunk[]>;
  saveExchange(documentId: string, question: string, answer: string, sources: AskSource[]): Promise<void>;
}

const failed = (what: string, error: { code?: string; message?: string } | null) => new Error(`Could not ${what} (${error?.code ?? error?.message ?? "unknown"})`);

// pgvector takes its value as text like "[0.1,0.2]".
const vectorText = (values: number[]) => `[${values.join(",")}]`;

const INSERT_BATCH = 50;

export function createSupabaseDocStore(client: SupabaseClient, userId: string): DocStore {
  async function setStatus(documentId: string, fields: Record<string, unknown>) {
    const { error } = await client.from("documents").update(fields).eq("id", documentId);
    if (error) throw failed("update the document", error);
  }

  return {
    async begin(documentId) {
      const { data, error } = await client
        .from("documents")
        .update({ status: "processing", error: null })
        .eq("id", documentId)
        .select("storage_path")
        .maybeSingle();
      if (error) throw failed("start processing the document", error);
      return (data?.storage_path as string | undefined) ?? null;
    },

    async status(documentId) {
      const { data, error } = await client.from("documents").select("status").eq("id", documentId).maybeSingle();
      if (error) throw failed("read the document", error);
      return (data?.status as string | undefined) ?? null;
    },

    async download(storagePath) {
      const { data, error } = await client.storage.from("documents").download(storagePath);
      if (error || !data) throw failed("download the file", error);
      return new Uint8Array(await data.arrayBuffer());
    },

    async replaceChunks(documentId, chunks, pageCount) {
      // Not one transaction: if a step fails the caller marks the document failed and it can be
      // re-run, which starts again by clearing the chunks.
      const { error: deleteError } = await client.from("document_chunks").delete().eq("document_id", documentId);
      if (deleteError) throw failed("clear the old chunks", deleteError);

      for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
        const rows = chunks.slice(i, i + INSERT_BATCH).map((c) => ({
          document_id: documentId,
          user_id: userId,
          chunk_index: c.chunkIndex,
          page: c.page,
          content: c.content,
          embedding: vectorText(c.embedding),
        }));
        const { error } = await client.from("document_chunks").insert(rows);
        if (error) throw failed("save the chunks", error);
      }
      await setStatus(documentId, { status: "ready", error: null, page_count: pageCount });
    },

    async fail(documentId, message) {
      await setStatus(documentId, { status: "failed", error: message });
    },

    async match(documentId, embedding, count) {
      const { data, error } = await client.rpc("match_chunks", { query_embedding: vectorText(embedding), doc_id: documentId, match_count: count });
      if (error) throw failed("search the document", error);
      return ((data ?? []) as { page: number; content: string; similarity: number }[]).map((r) => ({
        page: r.page,
        content: r.content,
        similarity: r.similarity,
      }));
    },

    async saveExchange(documentId, question, answer, sources) {
      const { error } = await client.from("doc_messages").insert([
        { document_id: documentId, user_id: userId, role: "user", content: question, sources: null },
        { document_id: documentId, user_id: userId, role: "assistant", content: answer, sources },
      ]);
      if (error) throw failed("save the conversation", error);
    },
  };
}
