import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseDocStore } from "./store.js";

interface Call {
  table: string;
  op: "select" | "update" | "insert" | "delete";
  payload?: unknown;
  filters: Record<string, unknown>;
}

type Answer = { data: unknown; error: { code: string } | null };

// A stand-in for the supabase-js query builder, storage and rpc: records each call, answers from `respond`.
function fakeSupabase(respond: (call: Call) => Answer, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: {} };
      calls.push(call);
      const run = () => Promise.resolve(respond(call));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), chain),
        insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), chain),
        delete: () => ((call.op = "delete"), chain),
        eq: (key: string, value: unknown) => ((call.filters[key] = value), chain),
        maybeSingle: run,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
      };
      return chain;
    },
    ...extra,
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const ok = (data: unknown = null): Answer => ({ data, error: null });
const bad: Answer = { data: null, error: { code: "42501" } };

describe("Supabase doc store", () => {
  it("begin marks the document processing and returns its path, or null when it is not the caller's", async () => {
    const found = fakeSupabase(() => ok({ storage_path: "u1/d1.pdf" }));
    expect(await createSupabaseDocStore(found.client, "u1").begin("d1")).toBe("u1/d1.pdf");
    expect(found.calls[0]).toMatchObject({ table: "documents", op: "update", payload: { status: "processing", error: null }, filters: { id: "d1" } });

    expect(await createSupabaseDocStore(fakeSupabase(() => ok(null)).client, "u1").begin("d1")).toBeNull();
    await expect(createSupabaseDocStore(fakeSupabase(() => bad).client, "u1").begin("d1")).rejects.toThrow("42501");
  });

  it("status returns the status, or null", async () => {
    expect(await createSupabaseDocStore(fakeSupabase(() => ok({ status: "ready" })).client, "u1").status("d1")).toBe("ready");
    expect(await createSupabaseDocStore(fakeSupabase(() => ok(null)).client, "u1").status("d1")).toBeNull();
    await expect(createSupabaseDocStore(fakeSupabase(() => bad).client, "u1").status("d1")).rejects.toThrow("42501");
  });

  it("download reads the file as the user", async () => {
    const download = async (path: string) => ({ data: new Blob([path]), error: null });
    const { client } = fakeSupabase(() => ok(), { storage: { from: () => ({ download }) } });
    expect(new TextDecoder().decode(await createSupabaseDocStore(client, "u1").download("u1/d1.pdf"))).toBe("u1/d1.pdf");

    const failing = fakeSupabase(() => ok(), { storage: { from: () => ({ download: async () => ({ data: null, error: { code: "404" } }) }) } });
    await expect(createSupabaseDocStore(failing.client, "u1").download("x")).rejects.toThrow("download the file");
  });

  it("replaceChunks clears the old chunks, inserts in batches with vectors as text, then marks ready", async () => {
    const { client, calls } = fakeSupabase(() => ok());
    const chunks = Array.from({ length: 120 }, (_, i) => ({ chunkIndex: i, page: 1 + (i % 3), content: `c${i}`, embedding: [0.5, 1] }));

    await createSupabaseDocStore(client, "u1").replaceChunks("d1", chunks, 3);

    expect(calls[0]).toMatchObject({ table: "document_chunks", op: "delete", filters: { document_id: "d1" } });
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts).toHaveLength(3);
    expect((inserts[0]!.payload as unknown[]).length).toBe(50);
    expect((inserts[0]!.payload as Record<string, unknown>[])[0]).toEqual({ document_id: "d1", user_id: "u1", chunk_index: 0, page: 1, content: "c0", embedding: "[0.5,1]" });
    expect(calls.at(-1)).toMatchObject({ table: "documents", op: "update", payload: { status: "ready", error: null, page_count: 3 }, filters: { id: "d1" } });
  });

  it("replaceChunks stops when a step fails", async () => {
    const chunk = [{ chunkIndex: 0, page: 1, content: "c", embedding: [1] }];
    await expect(createSupabaseDocStore(fakeSupabase((c) => (c.op === "delete" ? bad : ok())).client, "u1").replaceChunks("d1", chunk, 1)).rejects.toThrow("clear the old chunks");
    await expect(createSupabaseDocStore(fakeSupabase((c) => (c.op === "insert" ? bad : ok())).client, "u1").replaceChunks("d1", chunk, 1)).rejects.toThrow("save the chunks");
    await expect(createSupabaseDocStore(fakeSupabase((c) => (c.op === "update" ? bad : ok())).client, "u1").replaceChunks("d1", chunk, 1)).rejects.toThrow("update the document");
  });

  it("fail saves the message on the document", async () => {
    const { client, calls } = fakeSupabase(() => ok());
    await createSupabaseDocStore(client, "u1").fail("d1", "No text layer found; OCR is not supported yet.");
    expect(calls[0]).toMatchObject({ op: "update", payload: { status: "failed", error: "No text layer found; OCR is not supported yet." }, filters: { id: "d1" } });
  });

  it("match calls match_chunks with the vector as text and maps the rows", async () => {
    const rpc = async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("match_chunks");
      expect(args).toEqual({ query_embedding: "[1,2]", doc_id: "d1", match_count: 6 });
      return { data: [{ id: "x", chunk_index: 0, page: 2, content: "text", similarity: 0.8 }], error: null };
    };
    const { client } = fakeSupabase(() => ok(), { rpc });
    expect(await createSupabaseDocStore(client, "u1").match("d1", [1, 2], 6)).toEqual([{ page: 2, content: "text", similarity: 0.8 }]);

    const empty = fakeSupabase(() => ok(), { rpc: async () => ({ data: null, error: null }) });
    expect(await createSupabaseDocStore(empty.client, "u1").match("d1", [1], 6)).toEqual([]);
    const failing = fakeSupabase(() => ok(), { rpc: async () => ({ data: null, error: { message: "boom" } }) });
    await expect(createSupabaseDocStore(failing.client, "u1").match("d1", [1], 6)).rejects.toThrow("boom");
  });

  it("saveExchange stores the question and the answer with its sources", async () => {
    const { client, calls } = fakeSupabase(() => ok());
    await createSupabaseDocStore(client, "u1").saveExchange("d1", "Q?", "A (p. 2)", [{ page: 2, snippet: "s" }]);
    expect(calls[0]).toMatchObject({
      table: "doc_messages",
      op: "insert",
      payload: [
        { document_id: "d1", user_id: "u1", role: "user", content: "Q?", sources: null },
        { document_id: "d1", user_id: "u1", role: "assistant", content: "A (p. 2)", sources: [{ page: 2, snippet: "s" }] },
      ],
    });
    await expect(createSupabaseDocStore(fakeSupabase(() => bad).client, "u1").saveExchange("d1", "Q", "A", [])).rejects.toThrow("save the conversation");
  });
});
