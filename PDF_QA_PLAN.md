# PDF Q&A (RAG) Feature: Implementation Plan

Goal: let a TaskTide user upload a PDF and ask questions that are answered only from that document, with page citations.

## Context

* Frontend: TaskTide (Vite + Next.js), Supabase for auth and DB.
* Backend: `llm-gateway` repo, `assistant` module (already hosts the daily summary endpoint).
* Rule: the UI never calls the LLM or embedding provider directly. All AI calls go through `llm-gateway`.

## Architecture

```
TaskTide UI
  |-- upload PDF --> Supabase Storage (private bucket "documents")
  |-- POST /assistant/docs            (ingest)
  |-- POST /assistant/docs/ask        (question)
            |
      llm-gateway /assistant
        Ingest: download PDF -> extract text per page -> chunk -> embed -> insert
        Ask:    embed question -> match_chunks (pgvector) -> LLM -> answer + sources
            |
   Supabase Storage | Postgres + pgvector | Embedding API | LLM
```

## Instructions for Claude Code

1. First read both repos and note: gateway language/framework, how the existing daily summary endpoint authenticates and calls the LLM, and how TaskTide calls the gateway. Follow those conventions.
2. Work phase by phase. Stop after each phase for review. Do not start the next one unprompted.
3. Do not use the Supabase service key for user-facing queries. Always verify the user's JWT in the gateway.
4. Keep the embedding model and vector dimension in one config constant. Default dimension below is 1536; change it if the chosen model differs.

## Phase 1: Database (Supabase migration)

* [x] Enable extension: `create extension if not exists vector;`
* [x] Table `documents`: `id uuid pk`, `user_id uuid` (refs auth.users), `title text`, `storage_path text`, `status text` (`processing` | `ready` | `failed`), `error text null`, `page_count int null`, `created_at timestamptz`.
* [x] Table `document_chunks`: `id uuid pk`, `document_id uuid` (refs documents, on delete cascade), `user_id uuid`, `chunk_index int`, `page int`, `content text`, `embedding vector(1536)`.
* [x] HNSW index on `document_chunks.embedding` (cosine ops). Index on `document_id`.
* [x] RLS enabled on both tables. Policies: select/insert/update/delete only where `auth.uid() = user_id`.
* [x] Private Storage bucket `documents`, with policies limiting each user to their own folder (`{user_id}/...`).
* [x] SQL function `match_chunks(query_embedding vector, doc_id uuid, match_count int)` returning content, page, and similarity, filtered by document and by `auth.uid()`.
* [x] Optional: `doc_messages` table (document_id, user_id, role, content, sources jsonb, created_at) for chat history.

Done when: migration applies cleanly, and a second test user cannot read the first user's rows or files.

Status: done. Applied to the main Supabase project (branching needs the Pro plan) and `supabase/tests/pdf_qa_isolation_check.sql` passed; test data was rolled back.

## Phase 2: Ingest endpoint (`POST /assistant/docs`)

* [ ] Input: `document_id`. Auth: user JWT. Confirm the document belongs to the caller.
* [ ] Set status `processing`. Download the PDF from Storage. Enforce a size limit (start at 20 MB) and a page limit.
* [ ] Extract text per page, keeping the page number. If a PDF yields almost no text (likely scanned), mark `failed` with a clear error ("no text layer; OCR not supported yet").
* [ ] Chunk: about 500-800 tokens, 10-15% overlap, never crossing a page boundary unless needed. Store the page for each chunk.
* [ ] Embed in batches with retry and backoff. Insert chunks.
* [ ] Set status `ready`, or `failed` with the error message. Make re-running ingest idempotent (delete existing chunks for the document first).
* [ ] Run the work in the background so the request returns quickly. The UI tracks status.

Done when: a sample PDF ends up `ready` with sensible chunks, and a bad or empty PDF ends up `failed` with a readable error.

## Phase 3: Ask endpoint (`POST /assistant/docs/ask`)

* [ ] Input: `document_id`, `question`. Auth: user JWT. Confirm ownership and `status = ready`.
* [ ] Embed the question. Call `match_chunks` with k = 5-8.
* [ ] Apply a similarity threshold. If nothing passes, return "I couldn't find that in this document" without calling the LLM.
* [ ] Prompt: answer only from the provided context; cite page numbers; say so if the answer isn't in the context; low temperature.
* [ ] Return the answer and sources (page, snippet). Stream the answer with SSE if the existing gateway pattern supports it.
* [ ] Add per-user rate limiting and basic logging (question length, chunks retrieved, top similarity, latency, token usage).

Done when: questions about the document return correct answers with page citations, and off-topic questions return the "not found" response.

## Phase 4: TaskTide UI

* [ ] Documents page: upload button, list with title and status chip (processing / ready / failed), delete action.
* [ ] Upload flow: upload to Storage at `{user_id}/{document_id}.pdf`, insert the `documents` row, call the ingest endpoint.
* [ ] Status updates via Supabase Realtime subscription (or polling as a fallback).
* [ ] Chat panel per document: input, streamed answer, citations that show the page number and snippet.
* [ ] Empty, loading, and error states for every step.

Done when: the full flow works end to end from the browser as a signed-in user.

## Phase 5: Hardening and POC polish

* [ ] Small eval set: 10-15 questions with expected answers and source pages. Script that reports retrieval hit rate and answer correctness.
* [ ] Tests: chunking, JWT/ownership checks, "not found" path.
* [ ] Cost and abuse controls: file size, pages per doc, questions per minute.
* [ ] README for the repo: architecture diagram, setup, env vars, known limitations.

## Known limitations (list in README)

* No OCR for scanned PDFs.
* Single-document questions only.
* Simple fixed-size chunking, no reranking.

## Future ideas

* Hybrid keyword + vector search and reranking.
* Multi-document questions and conversation memory.
* OCR fallback.
* Embedding model versioning and re-embedding.
* Caching repeated questions.

## Open decisions (resolve before Phase 1)

1. Embedding model (sets the vector dimension).
2. PDF parsing library (match the gateway's language).
3. Streaming (SSE) vs. single response.
