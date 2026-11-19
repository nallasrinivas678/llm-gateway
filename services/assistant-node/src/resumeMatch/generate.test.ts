import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGenerate, createRateLimiter, isQuotaError } from "./generate.js";

// A model whose structured output answers from a list, one per call.
function fakeModel(...answers: unknown[]) {
  const invoke = vi.fn(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const withStructuredOutput = vi.fn(() => ({ invoke }));
  return { model: { withStructuredOutput } as unknown as BaseChatModel, invoke, withStructuredOutput };
}

const schema = z.object({ answer: z.string() });
const prompt = { name: "test_prompt", system: "sys", user: "hello" };

describe("createGenerate", () => {
  it("asks for the named structured output and returns the parsed answer", async () => {
    const { model, invoke, withStructuredOutput } = fakeModel({ answer: "yes" });
    expect(await createGenerate(model, { timeoutSeconds: 5, maxRetries: 0 })(schema, prompt)).toEqual({ answer: "yes" });
    expect(withStructuredOutput).toHaveBeenCalledWith(schema, { name: "test_prompt" });
    const [messages, options] = invoke.mock.calls[0] as unknown as [{ content: string }[], { signal: AbortSignal }];
    expect(messages.map((m) => m.content)).toEqual(["sys", "hello"]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once after a failure or an answer that does not fit the schema", async () => {
    const { model, invoke } = fakeModel({ wrong: true }, { answer: "second try" });
    expect(await createGenerate(model, { timeoutSeconds: 5, maxRetries: 1 })(schema, prompt)).toEqual({ answer: "second try" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last retry with the last error", async () => {
    const { model, invoke } = fakeModel(new Error("first"), new Error("second"));
    await expect(createGenerate(model, { timeoutSeconds: 5, maxRetries: 1 })(schema, prompt)).rejects.toThrow("second");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("quota errors", () => {
  it("are not retried", async () => {
    const quota = Object.assign(new Error("quota"), { status: 429 });
    const { model, invoke } = fakeModel(quota, { answer: "never reached" });
    await expect(createGenerate(model, { timeoutSeconds: 5, maxRetries: 1 })(schema, prompt)).rejects.toBe(quota);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("are recognised by status 429 only", () => {
    expect(isQuotaError({ status: 429 })).toBe(true);
    expect(isQuotaError({ status: 500 })).toBe(false);
    expect(isQuotaError("429")).toBe(false);
    expect(isQuotaError(null)).toBe(false);
  });
});

describe("createRateLimiter", () => {
  it("allows the limit per user per minute, then frees up as the minute passes", () => {
    let time = 0;
    const allow = createRateLimiter(2, () => time);
    expect([allow("a"), allow("a"), allow("a"), allow("b")]).toEqual([true, true, false, true]);
    time = 60_001;
    expect(allow("a")).toBe(true);
  });
});
