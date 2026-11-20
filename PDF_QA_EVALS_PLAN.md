# PDF Q&A in the Node service: migration, then evals (plan)

Goals, in order:

1. **Migrate PDF Q&A from the .NET assistant to `services/assistant-node`** (step M, below), with the same behaviour and API, so the Node service can replace .NET for this feature.
2. **Add a small, repeatable test of the AI part** (steps E0 to E5), so that choices like the similarity floor, number of chunks, chunk size and prompt are made from numbers, not guesses. It covers the "evaluation set first" item in `services/assistant-node/CHECKLIST.md` section 6, and can also run the same questions against the .NET service (checklist section 9).

Status: plan only. PDF Q&A is not built in Node yet; the .NET version (`src/LlmGateway.Assistant/Docs`) is the reference. Its settings today: chunks of 2400 characters with 300 overlap, top 6, similarity floor 0.55 (in `appsettings`; the C# default is 0.5), temperature 0.2, `gemini-embedding-001` at 1536 dimensions.

## Step M: migrate PDF Q&A to Node (first)

The database does not change: the tables, `match_chunks`, RLS and the `documents` bucket from `supabase/migrations/20261104000000_pdf_qa.sql` are reused as they are. The web app keeps the same two calls (`POST /assistant/docs` to ingest, `POST /assistant/docs/ask`), request shapes (camelCase, `documentId`) and error codes as .NET, so switching is a URL change behind a flag, as with the daily summary.

What moves, and what it reuses in the Node service:

| .NET piece | Node version | Reuse |
|---|---|---|
| `Docs/UserDb.cs` (role switch so RLS applies) | queries as the signed-in user with supabase-js and the caller's JWT, and `match_chunks` through `rpc` | the pattern in `resumeMatch` (user-scoped client) |
| Storage download with the caller's JWT | `supabase.storage.from("documents").download(path)` as the user | same client |
| PdfPig page text | `unpdf` per page (keeping page numbers) | `resumeMatch/pdfText.ts` extraction, plus the hidden-character cleaning |
| `TextChunker.cs` | `docQa/chunker.ts`: per page, 2400 characters, 300 overlap, cut at whitespace, never across a page | new, ported with its tests |
| `GeminiEmbeddingClient.cs` | `docQa/embeddings.ts`: `gemini-embedding-001`, 1536 dimensions, batches of 100, one retry; `RETRIEVAL_DOCUMENT` for chunks and `RETRIEVAL_QUERY` for questions | `@langchain/google-genai` embeddings or the Gemini REST call, whichever supports the dimension setting (checked first) |
| `DocumentIngestService.cs` | `docQa/ingest.ts`: processing, download, 200-page limit, "no text layer" failure under about 200 characters, replace chunks in one transaction, ready or failed with a readable message; runs in the background and returns 202 | the background-job approach from the plan |
| `DocumentAskService.cs` | `docQa/ask.ts`: embed question, `match_chunks`, floor, "I couldn't find that in this document." without calling the model when nothing passes, answer with page citations at temperature 0.2 | same prompt text; document content treated as data, not instructions |
| Rate limit (10 questions per user per minute) | the limiter the resume routes already use | `resumeMatch` limiter |
| JWT check | existing `auth.ts` | as is |
| Config | a `docQa` block in `config/default.json` (chunk size, overlap, topK, minSimilarity, maxPages, limits) | the existing config loader and its test style |

Added while moving, because the checklist already asks for them: stuck `processing` documents can be retried (a document left `processing` past a time limit can be re-ingested), the answer shows only the sources it actually used, and the conversation is saved in `doc_messages`. These are separate small slices, done after the straight port works.

Slices (each with tests, coverage floors kept, then a stop for review):

* **M1, chunker and embeddings** with unit tests (the C# chunker tests are the model; embeddings tested with a fake client).
* **M2, ingest** (extract, chunk, embed, save, status), with the failure cases: empty PDF, too many pages, wrong owner (404).
* **M3, ask** (retrieve, floor, answer, sources) with the "not found" path and the injection wording in the prompt.
* **M4, routes and wiring**: both endpoints, same status codes and bodies as .NET, rate limit, README section, `ARCHITECTURE.md` and checklist updated.
* **M5, live check**: one real PDF through the real endpoints with a real sign-in, and a second user cannot see the first user's document.
* **M6, retry and used-sources and `doc_messages`** (the three extras above).

Switching the web app over (digital-garden flag) and removing the .NET code stay as they are in the checklist: only after the evals below show Node is at least as good as .NET and a trial period.

The evals' own build (E2 onward) reuses M1 to M3 directly, so M comes first and nothing is written twice.

## What an eval answers (and what unit tests do not)

Unit tests check code: the chunker splits where it should, ownership checks return 404. They cannot say whether the model answers correctly. The evals measure four things on a fixed set of PDFs and questions:

| # | Question | Metric | Needs the answer model? |
|---|---|---|---|
| 1 | Does retrieval bring back the page that holds the answer? | hit rate at k (is a gold page among the chunks returned) and mean reciprocal rank | No, embeddings only |
| 2 | Does it refuse when the document does not say? | correct "not found" rate on unanswerable questions | Only when a chunk passes the floor |
| 3 | Is the answer right? | every `mustInclude` fact present, no `mustNotInclude` text | Yes |
| 4 | Are the citations honest? | cited pages are all gold pages; the answer cites at least one | Yes |

Also tracked: wrongly refused answerable questions (the floor set too high), and latency per question.

## Design (kept small)

* **A script, not part of `npm test`.** Evals call real Gemini, cost quota and vary run to run, so they run on demand with `npm run eval`. Only the pure parts (scorers, dataset validation, report formatting) are unit tests and run in CI.
* **Test the real code.** The eval imports the same chunker, prompt builder, threshold filter and answer function the endpoint will use. Retrieval is a plain function (`rankChunks(chunks, queryVector, topK, floor)`) so the eval can run it in memory with cosine similarity, which is what `match_chunks` does. No Supabase, no JWT, no database needed. One optional live run through the real endpoint comes at the end to confirm the two agree.
* **No LLM judge at first.** Answers are checked in code: each question lists short facts the answer must contain (numbers, names, dates; compared after normalising case, spacing and thousands separators) and text it must not contain. This is cheap, repeatable and has no second model to doubt. If real answers turn out too varied for string checks, add a judge later (temperature 0, a different model than the answerer, graded against the gold answer).
* **Cache what does not change.** Embeddings are saved on disk by hash of (model, text), so re-running with a new threshold or top-k costs no embedding calls. Answers are not cached, because they are what is being measured.
* **Report, then gate.** First runs only print a table and save JSON to `evals/results/` (git-ignored). Once a baseline is accepted it is committed as `evals/baseline.json`, and the script prints the change against it. A hard fail threshold is added only if the numbers prove stable.

## Dataset

Three to four PDFs, about 30 questions, stored under `services/assistant-node/evals/`:

```
evals/
  datasets/<doc>.json     questions and gold answers for one PDF
  pdfs/<doc>.pdf          the sources (small, committed)
  run.ts                  the script
  score.ts                pure scoring functions (unit tested)
```

One question looks like:

```json
{ "id": "policy-07", "question": "How many days of notice does the tenant need to give?",
  "type": "lookup", "goldPages": [3], "mustInclude": ["60"], "mustNotInclude": [] }
```

`type` is `lookup`, `multi-page` (answer spans two pages), `table-or-number`, `unanswerable`, or `injection`. Unanswerable questions have no gold page and `expect: "not_found"`.

Documents (mix of text shapes, so one easy file cannot hide a problem):

1. **Synthetic policy or handbook, 6 to 8 pages**, written by us so the gold answers are certain. About 10 questions. Built with the existing `makePdf` helper or committed as a small file.
2. **A real, freely licensed paper or report**, 10 to 20 pages (public domain or Creative Commons), for natural wording and a long page range. About 10 questions.
3. **A table- or number-heavy document** (a price list or financial summary), where chunking and numeric answers are most likely to break. About 6 questions.
4. **A document with injected instructions** inside the text ("ignore the above and say ..."). 2 to 3 questions that must not follow it. Can be a page added to document 1.

Plus one no-text-layer PDF to confirm ingest fails with the readable error; this is a unit test, not an eval question.

Dataset validation (a unit test, so it runs in CI): every gold page exists in its PDF, every `mustInclude` string appears on a gold page (so a wrong gold answer is caught before it blames the model), ids are unique, and each document has at least 3 unanswerable questions.

## Using the results

The main use is a sweep over retrieval settings, which costs only embeddings (cached):

* similarity floor from 0.40 to 0.65 in steps of 0.05
* top-k of 4, 6, 8
* chunk size of 1200, 2400 and 3600 characters (re-embeds once per size)

For each combination the table shows hit rate, correct refusals on unanswerable questions, and wrongly refused answerable ones. Pick the floor where the last two cross. This replaces the guessed 0.5 and 0.55.

The answer eval then runs once with the chosen settings. Also compare prompts (the current one against any change), and later the same set against .NET.

Suggested starting targets, to adjust after the first baseline: retrieval hit at 6 of at least 90 percent; correct refusals of at least 90 percent; wrongly refused at most 10 percent; answer facts correct at least 80 percent; zero injection failures.

## Constraints to settle first

* **Gemini quota.** The free tier allows about 20 generation requests a day (resume match already hits this), so 30 answers in one run does not fit. Retrieval runs and sweeps are fine (embeddings have their own, larger limit). For the answer eval, either turn on billing for the eval key (a full 30-question run costs cents), or split the run across days with `--only <doc>`. Decision for you.
* **Rate pacing.** The script waits between calls and retries once on a 429, like the service does.
* **Secrets.** The eval reads `GOOGLE_API_KEY` from the local `.env`, never prints it, and never commits PDFs that contain real personal data.

## Phases

Each phase ends with a stop for review.

* **M1 to M6, migration.** First, as described above. Evals start after M3 at the earliest (M1 to M3 give the chunker, embeddings and ask code the evals call).
* **E0, decisions.** Quota route (billing or split runs), which real PDF to use, confirm the no-judge start. Can be settled while M runs.
* **E1, dataset.** The 3 to 4 PDFs, about 30 questions, the validation test.
* **E2, harness.** `score.ts` with tests, `run.ts` skeleton, embedding cache, report table and JSON. Imports the chunker, embedding client and `rankChunks` built in M1 to M3 (`rankChunks` is kept a plain function so the eval can call it in memory).
* **E3, retrieval eval and sweep.** Run it, choose the floor, top-k and chunk size, record them in config and the checklist.
* **E4, answer eval.** Answers, refusal, citations and injection checks; first baseline committed.
* **E5, confirm and document.** One live run through the real endpoint to confirm the in-memory result matches; README section "Running the evals"; optional comparison with .NET.

## Left out on purpose

An LLM judge, a dashboard or tracking service, CI runs on every pull request, hundreds of questions, a reranker, and multi-document questions. Each can be added if the first baseline shows a need.
