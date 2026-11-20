import { describe, expect, it, vi } from "vitest";
import { createEmbedder } from "./embeddings.js";

const options = { apiKey: "k", model: "gemini-embedding-001", dimensions: 3, timeoutSeconds: 5, retryDelayMs: 0 };
const vector = [0.1, 0.2, 0.3];
const ok = (count: number) => new Response(JSON.stringify({ embeddings: Array.from({ length: count }, () => ({ values: vector })) }), { status: 200 });
const asFetch = (fn: unknown) => fn as typeof fetch;

describe("createEmbedder", () => {
  it("sends the model, task type, dimensions and key, and returns the vectors", async () => {
    const fetchFn = vi.fn(async () => ok(2));
    const embed = createEmbedder(options, asFetch(fetchFn));

    expect(await embed(["a", "b"], "RETRIEVAL_DOCUMENT")).toEqual([vector, vector]);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("gemini-embedding-001:batchEmbedContents");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
    const body = JSON.parse(init.body as string);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 3, model: "models/gemini-embedding-001" });
  });

  it("splits into batches of 100 and keeps the order", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => ok(JSON.parse(init.body as string).requests.length));
    const embed = createEmbedder(options, asFetch(fetchFn));

    const result = await embed(Array.from({ length: 250 }, (_, i) => `t${i}`), "RETRIEVAL_QUERY");

    expect(result).toHaveLength(250);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("makes no call for no texts", async () => {
    const fetchFn = vi.fn();
    expect(await createEmbedder(options, asFetch(fetchFn))([], "RETRIEVAL_DOCUMENT")).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retries once after a 429 or a network error", async () => {
    const busy = vi.fn().mockResolvedValueOnce(new Response("busy", { status: 429 })).mockResolvedValueOnce(ok(1));
    expect(await createEmbedder(options, asFetch(busy))(["a"], "RETRIEVAL_QUERY")).toEqual([vector]);
    expect(busy).toHaveBeenCalledTimes(2);

    const flaky = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(ok(1));
    expect(await createEmbedder(options, asFetch(flaky))(["a"], "RETRIEVAL_QUERY")).toEqual([vector]);
  });

  it("gives up after the second failure, and does not retry a bad request", async () => {
    const twice = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(createEmbedder(options, asFetch(twice))(["a"], "RETRIEVAL_QUERY")).rejects.toThrow("status 503");
    expect(twice).toHaveBeenCalledTimes(2);

    const bad = vi.fn(async () => new Response("no", { status: 400 }));
    await expect(createEmbedder(options, asFetch(bad))(["a"], "RETRIEVAL_QUERY")).rejects.toThrow("status 400");
    expect(bad).toHaveBeenCalledTimes(1);

    const down = vi.fn().mockRejectedValue(new Error("net"));
    await expect(createEmbedder(options, asFetch(down))(["a"], "RETRIEVAL_QUERY")).rejects.toThrow("net");
  });

  it("rejects a wrong count or wrong length", async () => {
    const few = vi.fn(async () => ok(1));
    await expect(createEmbedder(options, asFetch(few))(["a", "b"], "RETRIEVAL_QUERY")).rejects.toThrow("1 embeddings for 2");

    const short = vi.fn(async () => new Response(JSON.stringify({ embeddings: [{ values: [1] }] }), { status: 200 }));
    await expect(createEmbedder(options, asFetch(short))(["a"], "RETRIEVAL_QUERY")).rejects.toThrow("not 3 numbers");

    const empty = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(createEmbedder(options, asFetch(empty))(["a"], "RETRIEVAL_QUERY")).rejects.toThrow("0 embeddings");
  });
});
