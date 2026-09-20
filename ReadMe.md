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

## Roadmap

- [ ] **Phase 1 — MVP**: single provider (Azure OpenAI), retry + timeout via Polly, request logging to Cosmos DB
- [ ] **Phase 2**: circuit breaker + fallback to a second provider, Redis cache
- [ ] **Phase 3**: cost tracking dashboard + budget alerts, Application Insights tracing
- [ ] **Phase 4**: Service Bus-based queueing for burst handling, eval-gated CI pipeline
- [ ] **Next project**: [Insurance Claims Triage Agent](https://github.com/nallasrinivas678) built on top of this gateway

## License

MIT
