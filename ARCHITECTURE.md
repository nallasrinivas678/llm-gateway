# Architecture

This document goes one level deeper than the [README](ReadMe.md)'s architecture overview, covering how individual subsystems are actually implemented. Start with the README for the request-flow diagram and component table; come here for the "why does it work this way" detail.

## Response caching

LLM calls are slow (real network round-trips) and billed per token, so the gateway avoids repeating identical work when it safely can. The design constraint is that most LLM sampling is **non-deterministic**: with `temperature > 0`, the same prompt can legitimately produce different text on every call. Caching that output and replaying it later wouldn't just be imprecise — it would misrepresent what the model would actually say now. `temperature: 0` (greedy decoding) is the one case where a provider is effectively promising "the same input produces the same output," so that's the only case the gateway caches.

### How a request flows through the cache

Implemented in [`Caching/CachedChatCompletionService.cs`](src/LlmGateway.Api/Caching/CachedChatCompletionService.cs), which sits directly in front of `LlmProviderRouter`:

1. **Cacheability check** — only requests with `temperature == 0` are eligible. Anything else skips the cache entirely and always calls through live.
2. **Cache key** — a SHA-256 hash of `{ model, temperature, messages }` ([`CacheKeyGenerator.cs`](src/LlmGateway.Api/Caching/CacheKeyGenerator.cs)). The key deliberately **excludes `callerId`**: two different callers asking the identical deterministic question share one cache entry rather than each paying for their own copy. This is a shared, content-addressed cache, not a per-caller one.
3. **Read-through**:
   - **Hit** — return immediately. `cacheHit: true` in the response, and `latencyMs` reflects the actual cache lookup time (not the original provider latency from when the entry was written).
   - **Miss** — fall through to `LlmProviderRouter`, which runs the full retry → circuit-breaker → provider-fallback chain exactly as it would with no cache in the picture. On success, the response is written to the cache with a TTL before being returned.
4. **TTL** (`Cache:DefaultTtlSeconds`, default 300s) — even "deterministic" outputs can drift over time, since a provider can silently swap which model version sits behind a deployment name. Nothing is cached indefinitely.

### Failure handling: cache is optional, never a hard dependency

`RedisCacheStore` wraps every Redis call in a try/catch. A lookup failure is logged as a warning and treated as a cache miss; a write failure is logged and silently skipped. This means a Redis outage degrades the gateway to "every request calls the LLM directly" — it gets slower, but it never breaks. This mirrors the same philosophy applied to provider calls (retry/circuit-breaker/fallback): external dependencies fail, and the gateway's job is to keep working anyway, just without the optimization that dependency provided.

The `Cache:Enabled` flag (default `true`) lets the cache be turned off entirely — useful for environments without Redis available, or for isolating cache behavior while debugging. When disabled, `NullCacheStore` is registered instead of `RedisCacheStore`: every lookup misses, every write is a no-op, and `CachedChatCompletionService`'s logic is otherwise unchanged.

### Why exclude `callerId` from the key?

The alternative — scoping the cache per caller — would mean two services asking the exact same deterministic question each pay for their own LLM call and get their own cache entry. Since the whole point of caching a deterministic call is "this input has exactly one correct output," there's no correctness reason to duplicate that work per caller. What's shared is only the underlying computation: each caller who hits the shared entry still gets their own `RequestLogEntry` (correct `callerId`, `costUsd`, `cacheHit: true`) via `Program.cs`'s logging call, which uses the *requesting* caller's ID, not anything from the cached payload — usage/cost attribution per caller stays accurate even though the work behind a hit was deduplicated gateway-wide.
