# LLM Gateway

A production-grade resilience layer in front of LLM providers (Azure OpenAI, OpenAI, Anthropic, or a local model via Ollama), built as a **.NET 8 Minimal API**. Every LLM call is treated like any other unreliable, rate-limited, external dependency — with retries, circuit breaking, fallback routing, caching, cost tracking, and observability — instead of a raw HTTP call sprinkled through application code.

> Built as part of a backend-to-AI-engineering transition. The goal of this project specifically: prove out production infrastructure *before* building anything "AI-flavored" on top of it — an [Insurance Claims Triage Agent](#roadmap) is next, using this gateway as its LLM access layer.

## Why this exists

LLM APIs behave like any other flaky third-party network dependency: they rate-limit, time out, and vary in latency and cost. Most portfolio "AI" projects call a provider SDK directly and stop there. This one applies the same resilience engineering a backend team would apply to any critical external dependency — retries, circuit breakers, fallbacks, caching, cost metering, and tracing — as a standalone gateway service that other applications call instead of hitting a provider directly.

## Architecture

> See [ARCHITECTURE.md](ARCHITECTURE.md) for implementation-level detail on individual subsystems (currently: response caching).

```
Caller (e.g. Claims Triage Agent, or any client)
   │
   ▼
┌─────────────────────────────────────────────┐
│              LLM Gateway (Minimal API)        │
│                                               │
│  Auth / rate limit  ──▶  Cache lookup         │
│                              │ miss           │
│                              ▼                │
│                     Circuit breaker check     │
│                    (per provider/model)       │
│                              │ CLOSED         │
│                              ▼                │
│              Retry-wrapped provider call      │
│         (exponential backoff + jitter)        │
│                              │                │
│              success ────────┼──── exhausted  │
│                 │             │        │      │
│                 ▼             │        ▼      │
│         write cache          │   Fallback     │
│                 │             │   provider /   │
│                 └──────┬──────┘   model chain  │
│                        ▼                       │
│           record cost + trace, return          │
└─────────────────────────────────────────────┘
                        │
                        ▼
        Azure OpenAI / OpenAI / Anthropic / Ollama
```

### Core components

| Concern | Approach |
|---|---|
| Provider abstraction | `ILlmProvider` interface, one adapter per provider (Azure OpenAI, OpenAI, Anthropic, Ollama) |
| Retry | Polly retry policy — exponential backoff + jitter on 429 / 5xx / timeout |
| Circuit breaker | Polly circuit breaker, CLOSED → OPEN → HALF_OPEN per provider/model |
| Fallback | Polly fallback policy chaining to a secondary provider or cheaper model |
| Caching | Read-through cache keyed on hash(prompt, model, params) for deterministic (temp=0) calls |
| Cost tracking | Per-request token metering, attributed to caller ID, persisted for rollups |
| Observability | Structured tracing per call: latency, tokens, model, cache hit/miss, retry count, cost, outcome |
| Rate limiting | Inbound (ASP.NET Core rate limiting middleware) + outbound (respecting provider limits proactively) |

## Tech stack

- **.NET 8** — Minimal API (`Program.cs`, no MVC controllers)
- **Polly** — retry, circuit breaker, fallback, timeout policies
- **Redis** (Azure Cache for Redis in prod / Docker `redis` or Memurai locally) — response cache
- **Cosmos DB** (emulator locally) — request/cost/trace log store
- **Application Insights** (console/OpenTelemetry locally) — distributed tracing
- **Azure Key Vault** (`dotnet user-secrets` locally) — provider API keys
- **Azure Container Apps** or **App Service** for deployment (Docker-native)

## Getting started (local dev on Windows)

### Prerequisites

- [.NET 8 SDK](https://dotnet.microsoft.com/download)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) with WSL2 backend (for Redis + optional Cosmos emulator container)
- [Azure Cosmos DB Emulator](https://learn.microsoft.com/azure/cosmos-db/emulator) (native Windows install) — or run the cross-platform Docker image instead
- An API key for at least one provider (Azure OpenAI / OpenAI / Anthropic), **or** [Ollama](https://ollama.com) installed locally to run entirely for free during development

### Clone and restore

```powershell
git clone https://github.com/nallasrinivas678/llm-gateway.git
cd llm-gateway
dotnet restore
```

### Start local dependencies

```powershell
# Redis for the response cache
docker run -d --name llm-gateway-redis -p 6379:6379 redis:7

# Cosmos DB Emulator (native Windows) — start from Start Menu, or:
# docker run -d --name cosmos-emulator -p 8081:8081 -p 10250-10255:10250-10255 mcr.microsoft.com/cosmosdb/linux/azure-cosmos-emulator
```

### Configure secrets

```powershell
dotnet user-secrets init
dotnet user-secrets set "Providers:AzureOpenAI:ApiKey" "<your-key>"
dotnet user-secrets set "Providers:AzureOpenAI:Endpoint" "<your-endpoint>"
dotnet user-secrets set "Cache:RedisConnectionString" "localhost:6379"
dotnet user-secrets set "Storage:CosmosConnectionString" "<emulator-connection-string>"
```

> To develop the resilience logic (retry/circuit-breaker/fallback) without spending on real API calls, point `Providers:Default` at `Mock` (a local endpoint that deliberately returns 429/500/timeouts on a schedule) or `Ollama` (a real but free local model).

### Run

```powershell
dotnet run --project src/LlmGateway.Api
```

The API listens on `https://localhost:5001` by default. Swagger UI is available at `/swagger` in development.

## API

### `POST /v1/chat/completions`

Request:

```json
{
  "model": "gpt-4o-mini",
  "messages": [
    { "role": "user", "content": "Summarize this claim in one sentence." }
  ],
  "temperature": 0,
  "callerId": "claims-triage-agent"
}
```

Response:

```json
{
  "content": "The claim describes minor rear-end collision damage with no injuries reported.",
  "model": "gpt-4o-mini",
  "provider": "azure-openai",
  "usage": { "promptTokens": 42, "completionTokens": 18, "totalTokens": 60 },
  "cacheHit": false,
  "latencyMs": 812,
  "costUsd": 0.00021
}
```

### `GET /v1/usage/{callerId}`

Returns aggregated token usage and cost for a given caller over a time window — the read side of the cost-tracking feature.

### `GET /health`

Liveness/readiness probe, including current circuit breaker state per configured provider.

## Configuration

All configuration is bound from `appsettings.json` / environment variables / `dotnet user-secrets`, following standard ASP.NET Core configuration precedence — no custom config loader.

| Key | Purpose |
|---|---|
| `Providers:*` | Per-provider endpoint, API key, and priority (for fallback ordering) |
| `Resilience:RetryCount`, `Resilience:CircuitBreakerThreshold` | Polly policy tuning |
| `Cache:RedisConnectionString`, `Cache:DefaultTtlSeconds` | Cache behavior |
| `Storage:CosmosConnectionString` | Request/cost log persistence |
| `RateLimiting:*` | Inbound request throttling |

## Project structure

```
llm-gateway/
├── src/
│   └── LlmGateway.Api/
│       ├── Program.cs                  # minimal API endpoint mapping + DI wiring
│       ├── Providers/                  # ILlmProvider + one adapter per provider
│       ├── Resilience/                 # Polly policy registrations
│       ├── Caching/                    # cache key strategy + Redis implementation
│       ├── Cost/                       # token metering + usage rollups
│       ├── Observability/              # tracing middleware
│       └── appsettings.json
├── tests/
│   └── LlmGateway.Tests/               # unit + integration tests (incl. mock provider for resilience tests)
├── docker-compose.yml                  # local Redis + Cosmos emulator
└── README.md
#command to run docker:  docker-compose up -d
```

## PDF Q&A (RAG)

Lets a TaskTide user upload a PDF and ask questions answered **only from that document**, with page citations. Full phased checklist: [PDF_QA_PLAN.md](PDF_QA_PLAN.md).

| Phase | Scope | Status |
|---|---|---|
| 1 | Database: pgvector, tables, RLS, private storage bucket, `match_chunks` | Done: applied to the Supabase project; isolation check passed |
| 2 | Ingest endpoint `POST /assistant/docs` | Planned |
| 3 | Ask endpoint `POST /assistant/docs/ask` | Planned |
| 4 | TaskTide UI (upload, status, chat with citations) | Planned |
| 5 | Evals, tests, rate limits, hardening | Planned |

> Everything below Phase 1 describes the design, not shipped code.

### Architecture

```
 TaskTide UI (browser)
   │ 1. upload PDF  ───────────────►  Supabase Storage (private bucket "documents",
   │    insert documents row                           path {user_id}/{document_id}.pdf)
   │
   │ 2. POST /assistant/docs      { document_id }      Authorization: Bearer <Supabase JWT>
   │ 4. POST /assistant/docs/ask  { document_id, question }
   ▼
 LlmGateway.Assistant (.NET 8)  ── verifies JWT, checks the caller owns the document
   │
   ├─ INGEST (background):  download PDF → extract text per page → chunk (~500-800 tokens,
   │                         10-15% overlap, page kept) → embed in batches → insert chunks
   │                         → documents.status = ready | failed
   │
   └─ ASK:  embed question → match_chunks (top-k by cosine similarity)
            → below threshold?  "I couldn't find that in this document" (no LLM call)
            → otherwise build prompt (question + retrieved chunks) → LLM → answer + sources

 Supabase Postgres + pgvector     Embedding API (via gateway)     LLM (via gateway)
```

The UI never talks to the LLM or embedding provider. All AI calls go through the gateway, so retries, circuit breaking, fallback, caching and cost tracking apply to them too.

### Components

| Component | Responsibility | Where |
|---|---|---|
| Documents page + chat panel | Upload, status chips, ask questions, show page citations | TaskTide (Phase 4) |
| JWT auth + ownership check | Reject unauthenticated callers; confirm `documents.user_id` matches the caller | `LlmGateway.Assistant/Auth` (existing validator) |
| Ingest service | Extract text per page, chunk, embed, store, update status | `LlmGateway.Assistant` (Phase 2) |
| Ask service | Embed question, retrieve, apply threshold, prompt the LLM, return sources | `LlmGateway.Assistant` (Phase 3) |
| Embedding + LLM calls | Turn text into vectors; generate the answer | via the gateway's provider layer |
| Schema + `match_chunks` | Store documents, chunks and vectors; similarity search | [supabase/migrations/20261104000000_pdf_qa.sql](supabase/migrations/20261104000000_pdf_qa.sql) |
| Isolation check | Proves user B can't read or change user A's rows or files | [supabase/tests/pdf_qa_isolation_check.sql](supabase/tests/pdf_qa_isolation_check.sql) |

### Infrastructure

| Need | Choice | Notes |
|---|---|---|
| Auth | Supabase Auth | Gateway validates the user's JWT |
| File storage | Supabase Storage, private `documents` bucket | PDF-only, 20 MB limit, per-user folders enforced by policy |
| Database + vector search | Supabase Postgres + `pgvector` | HNSW index, cosine distance; `vector(1536)` |
| Embedding model | Open decision. Plan assumes 1536 dims (OpenAI `text-embedding-3-small`) | Changing it means changing the column and re-embedding |
| LLM | Existing gateway providers | Low temperature for grounded answers |
| PDF text extraction | Open decision (a .NET library, e.g. PdfPig) | No OCR: scanned PDFs fail with a clear error |
| Gateway hosting | Existing Fly.io / Docker setup | No new infrastructure |

### How to use it

**As a user (once Phases 2-4 exist):** upload a PDF on the Documents page, wait for the status chip to turn `ready`, open the document, and ask a question. Answers cite pages. An off-topic question gets "I couldn't find that in this document".

**As a developer, today (Phase 1 only):**

1. Apply [supabase/migrations/20261104000000_pdf_qa.sql](supabase/migrations/20261104000000_pdf_qa.sql) with `supabase db push` or the `apply_migration` tool, so it is recorded in migration history.
2. Run [supabase/tests/pdf_qa_isolation_check.sql](supabase/tests/pdf_qa_isolation_check.sql) as the `postgres` role. It runs in a transaction that rolls back, and should end with `PDF Q&A isolation checks passed`.

**Planned API contract:**

```
POST /assistant/docs        { "document_id": "<uuid>" }            -> 202 Accepted (ingest runs in background)
POST /assistant/docs/ask    { "document_id": "<uuid>", "question": "..." }
                            -> { "answer": "...", "sources": [ { "page": 3, "snippet": "..." } ] }
```

Both require `Authorization: Bearer <Supabase JWT>`.

### How RAG works with the LLM

An LLM only knows its training data and whatever is in the prompt. It has never seen the user's PDF, and a long PDF may not fit in the prompt or may be expensive to send on every question. RAG (retrieval-augmented generation) fixes this by sending only the relevant parts.

**Indexing (once per document):**
1. Extract text page by page, so every piece of text keeps its page number.
2. Split into chunks of about 500-800 tokens with 10-15% overlap, so an idea cut at a boundary still appears whole in one chunk.
3. Convert each chunk to an embedding: a 1536-number vector in which texts with similar meaning land close together.
4. Store `(content, page, embedding)` in `document_chunks`.

**Answering (every question):**
1. Embed the question with the same model.
2. `match_chunks` returns the top 5-8 chunks nearest to the question vector (cosine similarity, `1 - (embedding <=> query)`), for this document and this user only.
3. If even the best chunk is below a similarity threshold, stop and say the document doesn't cover it. This skips an LLM call, saves money, and avoids made-up answers.
4. Otherwise build a prompt: instructions ("answer only from the context, cite page numbers, say so if the answer isn't there"), the retrieved chunks labelled with their pages, and the question. Call the LLM at low temperature.
5. Return the answer plus the sources (page and snippet) so the user can verify it.

The LLM does the language work (reading the chunks and writing an answer). The vector search does the finding. Retrieval quality caps answer quality: if the right chunk isn't retrieved, the model can't answer correctly however good it is.

### Security model

Row-level security is on for every table, and the Storage policies limit each user to `{user_id}/…`. The plan requires querying as the signed-in user, not with the service key. The existing gateway code uses the service-role connection, which bypasses RLS. Phase 2 needs to run these queries under the `authenticated` role with the verified user id set for the transaction, so RLS applies. `match_chunks` also filters by `auth.uid()` as a second guard.

### Known limitations

- No OCR: scanned PDFs are rejected.
- One document per question.
- Fixed-size chunking, no reranking, no hybrid keyword search.
- Changing the embedding model requires re-embedding every chunk.

### Interview questions this feature invites

**RAG fundamentals**
- Why RAG instead of pasting the whole PDF into the prompt, or fine-tuning? *(Context limits and cost per question; fine-tuning is for style/behavior, not for injecting changing facts; RAG gives citations and updates by re-ingesting.)*
- What is an embedding, and why must the question and chunks use the same model? *(Vectors are only comparable within one embedding space.)*
- Why cosine similarity, and what does `<=>` return? *(`<=>` is cosine distance; similarity = 1 - distance.)*

**Chunking and retrieval**
- How did you choose chunk size and overlap? What goes wrong if chunks are too big or too small? *(Too big: diluted embeddings and wasted prompt tokens. Too small: lost context.)*
- Why keep chunks within a page? *(Reliable page citations.)*
- Why HNSW over IVFFlat or exact scan? Is an index even needed for one document? *(HNSW: good recall/latency without training; for a few hundred chunks per document an exact scan is already fast, so the index matters only for cross-document search.)*
- How would you improve retrieval? *(Hybrid BM25 + vector, reranking, query rewriting, metadata filters.)*

**Grounding and quality**
- How do you stop hallucinations? *(Similarity threshold, "answer only from context" prompt, low temperature, citations, "not found" path.)*
- How would you evaluate it? *(A labelled set of questions with expected pages: retrieval hit rate@k, then answer correctness; run it on every change to chunking or prompts.)*
- A user asks something the PDF doesn't cover. What happens, and why not just call the LLM? *(Threshold short-circuit.)*
- What about prompt injection hidden inside the PDF? *(Treat retrieved text as data, not instructions; delimit it in the prompt; the model has no tools in this flow, which limits the damage.)*

**Security and multi-tenancy**
- How do you stop user B reading user A's documents? *(RLS on all tables, per-user storage folders, ownership check in the gateway, composite foreign keys, `match_chunks` filtering by `auth.uid()`; the isolation script proves it.)*
- Why is using the service-role key for user queries dangerous? *(It bypasses RLS, so a single missing `where user_id = …` leaks data.)*
- Why the composite `(document_id, user_id)` foreign key? *(A child row's owner must equal its document's owner, enforced by the database.)*

**Systems design**
- Why is ingestion asynchronous with a status field? *(Extraction and embedding take seconds to minutes; request returns fast, UI tracks `processing → ready | failed`.)*
- How do you make ingestion idempotent and retry-safe? *(Delete existing chunks for the document first; unique `(document_id, chunk_index)`; batch embedding with backoff.)*
- What breaks if you change the embedding model? *(Dimension mismatch and incomparable vectors; plan a re-embedding job and store the model version.)*
- How do you control cost and abuse? *(Size and page limits, per-user rate limits, caching repeated questions, logging token usage; the gateway already tracks cost per caller.)*
- Why route embeddings and LLM calls through the gateway? *(One place for retries, circuit breaking, fallback, caching, cost tracking, and keeping provider keys off the client.)*
- What would you change to scale to millions of chunks or multi-document search? *(Keep HNSW, tune `m`/`ef_search`, partition or filter by user, consider a dedicated vector store if Postgres becomes the bottleneck.)*

## Roadmap

- [ ] **Phase 1 — MVP**: single provider (Azure OpenAI), retry + timeout via Polly, request logging to Cosmos DB
- [ ] **Phase 2**: circuit breaker + fallback to a second provider, Redis cache
- [ ] **Phase 3**: cost tracking dashboard + budget alerts, Application Insights tracing
- [ ] **Phase 4**: Service Bus-based queueing for burst handling, eval-gated CI pipeline
- [ ] **Next project**: [Insurance Claims Triage Agent](https://github.com/nallasrinivas678) built on top of this gateway

## License

MIT
