import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePdf } from "../resumeMatch/pdf.testutil.js";
import { DocBusyError, DocNotFoundError } from "./errors.js";
import { createIngestService } from "./ingest.js";
import type { DocStore } from "./store.js";

const settings = { maxPages: 5, maxPdfBytes: 1_000_000, minTextChars: 20, chunkChars: 2400, chunkOverlapChars: 300 };
const sentence = "The tenant must give sixty days of written notice before leaving the rental unit.";

function fakeStore(overrides: Partial<DocStore> = {}) {
  const store = {
    begin: vi.fn(async () => "u1/d1.pdf" as string | null),
    status: vi.fn(),
    download: vi.fn(async () => makePdf([[sentence], ["Rent is due on the first day of each month."]])),
    replaceChunks: vi.fn(async (..._args: unknown[]) => {}),
    fail: vi.fn(async () => {}),
    match: vi.fn(),
    saveExchange: vi.fn(),
    ...overrides,
  };
  return store as typeof store & DocStore;
}

const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2]));

describe("ingest", () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    embed.mockClear();
  });
  afterEach(() => error.mockRestore());

  it("extracts, chunks, embeds and saves the chunks with their pages", async () => {
    const store = fakeStore();
    const service = createIngestService({ openStore: () => store, embed, settings });

    const { done } = await service.start("u1", "jwt", "d1");
    await done;

    expect(store.begin).toHaveBeenCalledWith("d1");
    expect(store.download).toHaveBeenCalledWith("u1/d1.pdf");
    expect(embed).toHaveBeenCalledWith(expect.any(Array), "RETRIEVAL_DOCUMENT");
    const [documentId, rows, pageCount] = (store.replaceChunks as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as unknown as [string, { chunkIndex: number; page: number; embedding: number[] }[], number];
    expect(documentId).toBe("d1");
    expect(pageCount).toBe(2);
    expect(rows.map((r) => [r.chunkIndex, r.page])).toEqual([[0, 1], [1, 2]]);
    expect(rows[0]!.embedding).toEqual([0.1, 0.2]);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("is not found when the document is not the caller's", async () => {
    const service = createIngestService({ openStore: () => fakeStore({ begin: async () => null }), embed, settings });
    await expect(service.start("u1", "jwt", "d1")).rejects.toBeInstanceOf(DocNotFoundError);
  });

  it("marks a PDF with no text layer failed with a readable message", async () => {
    const store = fakeStore({ download: async () => makePdf([["Hi"]]) });
    const { done } = await createIngestService({ openStore: () => store, embed, settings }).start("u1", "jwt", "d1");
    await done;

    expect(store.fail).toHaveBeenCalledWith("d1", "No text layer found; OCR is not supported yet.");
    expect(store.replaceChunks).not.toHaveBeenCalled();
  });

  it("marks an unexpected failure failed with a generic message, and logs it", async () => {
    const store = fakeStore({ download: async () => { throw new Error("storage is down"); } });
    const { done } = await createIngestService({ openStore: () => store, embed, settings }).start("u1", "jwt", "d1");
    await done;

    expect(store.fail).toHaveBeenCalledWith("d1", "Processing failed. Please try again.");
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ event: "pdf ingest failed", error: "Error" });
    expect(String(error.mock.calls[0]?.[0])).not.toContain("storage is down");
  });

  it("copes when it cannot even mark the document failed", async () => {
    const store = fakeStore({ download: async () => { throw new Error("x"); }, fail: async () => { throw new Error("db down"); } });
    const { done } = await createIngestService({ openStore: () => store, embed, settings }).start("u1", "jwt", "d1");
    await expect(done).resolves.toBeUndefined();
  });

  it("refuses a second run of the same document while one is running, then allows a retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const store = fakeStore({ download: async () => (await gate, makePdf([[sentence]])) });
    const service = createIngestService({ openStore: () => store, embed, settings });

    const first = await service.start("u1", "jwt", "d1");
    await expect(service.start("u1", "jwt", "d1")).rejects.toBeInstanceOf(DocBusyError);
    expect(store.begin).toHaveBeenCalledTimes(1);

    release();
    await first.done;
    await expect((await service.start("u1", "jwt", "d1")).done).resolves.toBeUndefined();
  });
});
