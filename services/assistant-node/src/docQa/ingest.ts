// Ingest: download the PDF as the user, extract text per page, chunk, embed and save. Failures end
// in documents.status = "failed" with a short readable message; unexpected errors are logged and
// shown generically.
import { chunkPage } from "./chunker.js";
import type { EmbedFn } from "./embeddings.js";
import { DocBusyError, DocInputError, DocNotFoundError } from "./errors.js";
import { extractPages, type PageLimits } from "./pages.js";
import type { DocStore } from "./store.js";

export interface IngestSettings extends PageLimits {
  chunkChars: number;
  chunkOverlapChars: number;
}

export interface IngestService {
  // Marks the document "processing" and starts the work in the background. `done` settles when the
  // work has finished (the route does not wait for it; tests do).
  start(userId: string, jwt: string, documentId: string): Promise<{ done: Promise<void> }>;
}

export interface IngestDeps {
  openStore: (userId: string, jwt: string) => DocStore;
  embed: EmbedFn;
  settings: IngestSettings;
}

export function createIngestService(deps: IngestDeps): IngestService {
  // Documents being processed on this machine, so a second request cannot start a duplicate run.
  // A document left "processing" by a restart is not in here, so it can be started again (retry).
  const running = new Set<string>();

  async function run(store: DocStore, documentId: string, storagePath: string): Promise<void> {
    const { settings } = deps;
    try {
      const pages = await extractPages(await store.download(storagePath), settings);
      const chunks = pages.flatMap((p) => chunkPage(p.page, p.text, settings.chunkChars, settings.chunkOverlapChars));
      const vectors = await deps.embed(chunks.map((c) => c.content), "RETRIEVAL_DOCUMENT");
      await store.replaceChunks(
        documentId,
        chunks.map((c, index) => ({ chunkIndex: index, page: c.page, content: c.content, embedding: vectors[index]! })),
        pages.length,
      );
    } catch (error) {
      let message = "Processing failed. Please try again.";
      if (error instanceof DocInputError) message = error.message;
      else console.error("pdf ingest failed:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error");
      try {
        await store.fail(documentId, message);
      } catch (failError) {
        console.error("could not mark the document failed:", failError instanceof Error ? failError.message.slice(0, 200) : "unknown error");
      }
    } finally {
      running.delete(documentId);
    }
  }

  return {
    async start(userId, jwt, documentId) {
      if (running.has(documentId)) throw new DocBusyError();
      const store = deps.openStore(userId, jwt);
      const storagePath = await store.begin(documentId);
      if (!storagePath) throw new DocNotFoundError();
      running.add(documentId);
      return { done: run(store, documentId, storagePath) };
    },
  };
}
