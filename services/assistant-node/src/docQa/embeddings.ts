// Gemini batchEmbedContents over plain fetch. The dimensions must match document_chunks.embedding
// (vector(1536)); the model and dimensions are passed in so they live in one place (config).
export type EmbedTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbeddingOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutSeconds: number;
  retryDelayMs?: number;
}

export type EmbedFn = (texts: string[], task: EmbedTask) => Promise<number[][]>;

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const BATCH_SIZE = 100;

export function createEmbedder(options: EmbeddingOptions, fetchFn: typeof fetch = fetch): EmbedFn {
  // One call for up to BATCH_SIZE texts. One retry after a short pause covers a transient 429/5xx.
  async function embedBatch(texts: string[], task: EmbedTask): Promise<number[][]> {
    const body = JSON.stringify({
      requests: texts.map((text) => ({
        model: `models/${options.model}`,
        content: { parts: [{ text }] },
        taskType: task,
        outputDimensionality: options.dimensions,
      })),
    });

    for (let attempt = 1; ; attempt++) {
      let response: Response | null = null;
      let failure: unknown;
      try {
        response = await fetchFn(`${BASE_URL}/models/${options.model}:batchEmbedContents`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
          body,
          signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
        });
      } catch (error) {
        failure = error;
      }

      if (response?.ok) {
        const parsed = (await response.json()) as { embeddings?: { values?: number[] }[] };
        const vectors = (parsed.embeddings ?? []).map((e) => e.values ?? []);
        if (vectors.length !== texts.length) {
          throw new Error(`Gemini returned ${vectors.length} embeddings for ${texts.length} inputs.`);
        }
        if (vectors.some((v) => v.length !== options.dimensions)) {
          throw new Error(`Gemini returned embeddings that are not ${options.dimensions} numbers long.`);
        }
        return vectors;
      }

      // A bad request or key will not get better by trying again; a busy or failing server might.
      const retryable = !response || response.status === 429 || response.status >= 500;
      if (attempt >= 2 || !retryable) {
        throw failure ?? new Error(`Gemini embeddings failed with status ${response?.status}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 2000));
    }
  }

  return async (texts, task) => {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      vectors.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE), task)));
    }
    return vectors;
  };
}
