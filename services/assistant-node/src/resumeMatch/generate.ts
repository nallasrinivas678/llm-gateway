// The real GenerateFn: asks the chat model for JSON in a given shape (LangChain structured output),
// with a timeout on each try and a bounded number of retries.
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { GenerateFn } from "./matchService.js";

export function createGenerate(model: BaseChatModel, options: { timeoutSeconds: number; maxRetries: number }): GenerateFn {
  return async (schema, prompt) => {
    const structured = model.withStructuredOutput(schema, { name: prompt.name });
    const messages = [new SystemMessage(prompt.system), new HumanMessage(prompt.user)];
    let lastError: unknown;
    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      try {
        // Parsing against the schema again catches a model that ignored it.
        return schema.parse(await structured.invoke(messages, { signal: AbortSignal.timeout(options.timeoutSeconds * 1000) }));
      } catch (error) {
        lastError = error;
        // Retrying a used-up quota only uses more of it.
        if (isQuotaError(error)) break;
      }
    }
    throw lastError;
  };
}

// The model provider refused because the usage limit (requests per minute or per day) is reached.
export function isQuotaError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 429;
}

// Allows `limit` calls per user in any window (a minute unless said otherwise). In memory, per
// machine: enough to stop one user from running up model costs by accident, not a shared quota.
export function createRateLimiter(limit: number, now: () => number = Date.now, windowMs = 60_000) {
  const calls = new Map<string, number[]>();
  return (userId: string): boolean => {
    const time = now();
    const recent = (calls.get(userId) ?? []).filter((t) => time - t < windowMs);
    if (recent.length >= limit) {
      calls.set(userId, recent);
      return false;
    }
    recent.push(time);
    calls.set(userId, recent);
    return true;
  };
}
