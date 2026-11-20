import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUserMessage, citedPages, createAnswer, createAskService, filterRelevant, NOT_FOUND_ANSWER, sourcesUsed } from "./ask.js";
import { DocNotFoundError, DocNotReadyError } from "./errors.js";
import type { DocStore, RetrievedChunk } from "./store.js";

const chunk = (page: number, similarity: number, content = `text of page ${page}`): RetrievedChunk => ({ page, content, similarity });
const settings = { topK: 6, minSimilarity: 0.55 };

function fakeStore(overrides: Partial<DocStore> = {}) {
  const store = {
    begin: vi.fn(),
    status: vi.fn(async () => "ready" as string | null),
    download: vi.fn(),
    replaceChunks: vi.fn(),
    fail: vi.fn(),
    match: vi.fn(async () => [chunk(3, 0.9), chunk(5, 0.7), chunk(8, 0.4)]),
    saveExchange: vi.fn(async () => {}),
    ...overrides,
  };
  return store as typeof store & DocStore;
}

const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 2]));

describe("ask helpers", () => {
  it("keeps chunks at or above the floor, best first", () => {
    expect(filterRelevant([chunk(1, 0.3), chunk(2, 0.55), chunk(3, 0.9)], 0.55).map((c) => c.page)).toEqual([3, 2]);
  });

  it("builds the message with page labels and the question last", () => {
    expect(buildUserMessage("Why?", [chunk(2, 1, "alpha")])).toBe("Excerpts:\n\n[Page 2]\nalpha\n\nQuestion: Why?");
  });

  it("reads cited pages in the usual forms", () => {
    expect([...citedPages("Yes (p. 3). Also (pp. 5, 7 and 9) and see page 12.")].sort((a, b) => a - b)).toEqual([3, 5, 7, 9, 12]);
    expect(citedPages("No citations here, 2024 and 15 items.").size).toBe(0);
  });

  it("shows only the sources the answer cites, with a short snippet", () => {
    const long = chunk(3, 0.9, "x".repeat(300));
    const sources = sourcesUsed("It is 60 days (p. 3).", [long, chunk(5, 0.7)]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.page).toBe(3);
    expect(sources[0]!.snippet).toHaveLength(203);
    expect(sources[0]!.snippet.endsWith("...")).toBe(true);
  });

  it("shows every given chunk when the answer cites nothing readable or a page that was not given", () => {
    expect(sourcesUsed("It is 60 days.", [chunk(3, 0.9), chunk(5, 0.7)]).map((s) => s.page)).toEqual([3, 5]);
    expect(sourcesUsed("It is 60 days (p. 99).", [chunk(3, 0.9)]).map((s) => s.page)).toEqual([3]);
  });
});

describe("ask service", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    info.mockRestore();
    error.mockRestore();
  });

  it("embeds the question, searches, answers from the relevant chunks only and saves the exchange", async () => {
    const store = fakeStore();
    const answer = vi.fn(async () => "Sixty days (p. 3).");
    const result = await createAskService({ openStore: () => store, embed, answer, settings }).ask("u1", "jwt", "d1", "How long is the notice?");

    expect(embed).toHaveBeenCalledWith(["How long is the notice?"], "RETRIEVAL_QUERY");
    expect(store.match).toHaveBeenCalledWith("d1", [1, 2], 6);
    const [system, user] = answer.mock.calls[0] as unknown as [string, string];
    expect(system).toContain("ONLY the excerpts");
    expect(user).toContain("[Page 3]");
    expect(user).toContain("[Page 5]");
    expect(user).not.toContain("[Page 8]");
    expect(result).toEqual({ answer: "Sixty days (p. 3).", sources: [{ page: 3, snippet: "text of page 3" }] });
    expect(store.saveExchange).toHaveBeenCalledWith("d1", "How long is the notice?", "Sixty days (p. 3).", result.sources);
  });

  it("answers 'not found' without calling the model when nothing is close enough", async () => {
    const store = fakeStore({ match: async () => [chunk(1, 0.2)] });
    const answer = vi.fn();
    const result = await createAskService({ openStore: () => store, embed, answer, settings }).ask("u1", "jwt", "d1", "Unrelated?");

    expect(result).toEqual({ answer: NOT_FOUND_ANSWER, sources: [] });
    expect(answer).not.toHaveBeenCalled();
    expect(store.saveExchange).toHaveBeenCalled();
  });

  it("copes with a document that has no chunks", async () => {
    const store = fakeStore({ match: async () => [] });
    const result = await createAskService({ openStore: () => store, embed, answer: vi.fn(), settings }).ask("u1", "jwt", "d1", "Q?");
    expect(result.answer).toBe(NOT_FOUND_ANSWER);
  });

  it("is not found for a document that is not the caller's, and not ready while processing or failed", async () => {
    const service = (status: string | null) => createAskService({ openStore: () => fakeStore({ status: async () => status }), embed, answer: vi.fn(), settings });
    await expect(service(null).ask("u1", "jwt", "d1", "Q?")).rejects.toBeInstanceOf(DocNotFoundError);
    await expect(service("processing").ask("u1", "jwt", "d1", "Q?")).rejects.toThrow("Document is processing");
    await expect(service("failed").ask("u1", "jwt", "d1", "Q?")).rejects.toBeInstanceOf(DocNotReadyError);
  });

  it("still returns the answer when saving the conversation fails", async () => {
    const store = fakeStore({ saveExchange: async () => { throw new Error("db down"); } });
    const result = await createAskService({ openStore: () => store, embed, answer: async () => "Yes (p. 3).", settings }).ask("u1", "jwt", "d1", "Q?");
    expect(result.answer).toBe("Yes (p. 3).");
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ event: "could not save the document conversation", error: "Error" });
    expect(String(error.mock.calls[0]?.[0])).not.toContain("db down");
  });

  it("logs the question length and similarity, never the question", async () => {
    await createAskService({ openStore: () => fakeStore(), embed, answer: async () => "Yes (p. 3).", settings }).ask("u1", "jwt", "d1", "secret question text");
    const line = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({ event: "doc ask", questionLength: 20, topSimilarity: 0.9 });
    expect(line).not.toContain("secret");
  });
});

describe("createAnswer", () => {
  const model = (invoke: () => Promise<unknown>) => ({ invoke }) as unknown as BaseChatModel;

  it("returns the text of the model's reply", async () => {
    const answer = createAnswer(model(async () => new AIMessage("Hello")), { timeoutSeconds: 5, maxRetries: 1 });
    expect(await answer("system", "user")).toBe("Hello");
  });

  it("retries once, then gives up", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce(new AIMessage("ok"));
    expect(await createAnswer(model(invoke), { timeoutSeconds: 5, maxRetries: 1 })("s", "u")).toBe("ok");

    const always = vi.fn().mockRejectedValue(new Error("down"));
    await expect(createAnswer(model(always), { timeoutSeconds: 5, maxRetries: 1 })("s", "u")).rejects.toThrow("down");
    expect(always).toHaveBeenCalledTimes(2);
  });

  it("does not retry a used-up quota", async () => {
    const quota = vi.fn().mockRejectedValue(Object.assign(new Error("quota"), { status: 429 }));
    await expect(createAnswer(model(quota), { timeoutSeconds: 5, maxRetries: 3 })("s", "u")).rejects.toThrow("quota");
    expect(quota).toHaveBeenCalledTimes(1);
  });
});
