import { describe, expect, it, vi } from "vitest";
import { DocNotFoundError, DocNotReadyError } from "../docQa/errors.js";
import { createSupabaseDocumentList, documentTools, type DocumentAccess } from "./documentTools.js";

const ID = "6f1c1e0a-6a1e-4b8e-9d2f-0a5c8d7e1b11";

function access(overrides: Partial<DocumentAccess> = {}): DocumentAccess {
  return {
    list: vi.fn(async () => [
      { id: ID, title: "Lease agreement.pdf", pageCount: 12 },
      { id: "6f1c1e0a-6a1e-4b8e-9d2f-0a5c8d7e1b12", title: "Notes", pageCount: null },
    ]),
    ask: vi.fn(async () => ({ answer: "Pets are allowed with a deposit (p. 4).", sources: [{ page: 4 }, { page: 2 }, { page: 4 }] })),
    ...overrides,
  };
}
const tool = (name: string, overrides: Partial<DocumentAccess> = {}) => {
  const found = documentTools(access(overrides)).find((t) => t.name === name)!;
  return found;
};

describe("document tools", () => {
  it("offers a list tool and an ask tool", () => {
    expect(documentTools(access()).map((t) => t.name)).toEqual(["list_documents", "ask_document"]);
  });

  it("lists ids and titles with page counts", async () => {
    expect(await tool("list_documents").invoke({})).toBe(`- ${ID}: Lease agreement.pdf (12 pages)\n- 6f1c1e0a-6a1e-4b8e-9d2f-0a5c8d7e1b12: Notes`);
  });

  it("says when there are no documents, and when listing fails", async () => {
    expect(await tool("list_documents", { list: async () => [] }).invoke({})).toMatch(/no documents ready/);
    const failing = tool("list_documents", { list: async () => Promise.reject(new Error("db password leaked")) });
    const text = String(await failing.invoke({}));
    expect(text).toMatch(/^The document tool failed/);
    expect(text).not.toContain("leaked");
  });

  it("answers from the document with the distinct pages, in order", async () => {
    const fake = access();
    const ask = documentTools(fake).find((t) => t.name === "ask_document")!;
    expect(await ask.invoke({ documentId: ID, question: "Are pets allowed?" })).toBe("Pets are allowed with a deposit (p. 4).\n\n(Pages: 2, 4)");
    expect(fake.ask).toHaveBeenCalledWith(ID, "Are pets allowed?");
  });

  it("gives the bare answer when no pages are cited", async () => {
    const ask = tool("ask_document", { ask: async () => ({ answer: "I couldn't find that in this document.", sources: [] }) });
    expect(await ask.invoke({ documentId: ID, question: "What colour is it?" })).toBe("I couldn't find that in this document.");
  });

  it("explains a missing or unready document, and hides other errors", async () => {
    const args = { documentId: ID, question: "Anything?" };
    expect(await tool("ask_document", { ask: async () => Promise.reject(new DocNotFoundError()) }).invoke(args)).toMatch(/no document with that id/);
    expect(await tool("ask_document", { ask: async () => Promise.reject(new DocNotReadyError("processing")) }).invoke(args)).toMatch(/processing, not ready/);
    const text = String(await tool("ask_document", { ask: async () => Promise.reject(new Error("internal 10.0.0.1")) }).invoke(args));
    expect(text).toMatch(/^The document tool failed/);
    expect(text).not.toContain("10.0.0.1");
  });

  it("passes a used-up model quota up, so the chat can tell the user", async () => {
    const quota = Object.assign(new Error("429"), { status: 429 });
    await expect(tool("ask_document", { ask: async () => Promise.reject(quota) }).invoke({ documentId: ID, question: "Anything?" })).rejects.toThrow("429");
  });

  it("refuses an id that is not a uuid", async () => {
    await expect(tool("ask_document").invoke({ documentId: "../x", question: "Anything?" })).rejects.toThrow();
  });
});

describe("createSupabaseDocumentList", () => {
  function fakeClient(result: { data: unknown; error: { code?: string } | null }) {
    const calls: unknown[] = [];
    const chain: Record<string, unknown> = {};
    for (const name of ["select", "eq", "order"]) chain[name] = (...args: unknown[]) => (calls.push([name, ...args]), chain);
    chain.limit = (n: number) => (calls.push(["limit", n]), Promise.resolve(result));
    return { client: { from: (table: string) => (calls.push(["from", table]), chain) } as never, calls };
  }

  it("reads the ready documents as the caller, newest first", async () => {
    const { client, calls } = fakeClient({ data: [{ id: ID, title: "Lease", page_count: 3 }], error: null });
    expect(await createSupabaseDocumentList(client)(20)).toEqual([{ id: ID, title: "Lease", pageCount: 3 }]);
    expect(calls).toContainEqual(["from", "documents"]);
    expect(calls).toContainEqual(["eq", "status", "ready"]);
    expect(calls).toContainEqual(["limit", 20]);
  });

  it("returns an empty list for no rows and reports an error with its code", async () => {
    expect(await createSupabaseDocumentList(fakeClient({ data: null, error: null }).client)(20)).toEqual([]);
    await expect(createSupabaseDocumentList(fakeClient({ data: null, error: { code: "42501" } }).client)(20)).rejects.toThrow("42501");
  });
});
