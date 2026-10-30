# Deployment — LlmGateway.Assistant on Fly.io

This covers deploying **`src/LlmGateway.Assistant`** only — the project `digital-garden`/TaskTide actually calls (`/assistant/chat`, `/assistant/daily-summary`). `LlmGateway.Api` (the generic LLM-completions gateway with Redis caching) is a separate, currently-undeployed service; nothing here affects it.

## Why Fly.io

The root [ReadMe.md](ReadMe.md) documents Azure Container Apps/App Service as `LlmGateway.Api`'s target. For `LlmGateway.Assistant` we chose **Fly.io** instead: the rest of the stack (Vercel frontend, Supabase, Namecheap domain) is already outside the Azure ecosystem, and Fly is cheaper/simpler for a single small service with no scaling needs yet. The Dockerfile this produced is reusable later if a heavier platform (e.g. AKS, per `src/LlmGateway.Api/docs/plan.md`'s original roadmap) is ever needed.

## Architecture

```
digital-garden / TaskTide (Vercel)
         │  HTTPS, Supabase session JWT
         ▼
┌─────────────────────────────────────────────┐
│         Fly.io edge (anycast + TLS)           │
│         llm-gateway-prnhia.fly.dev            │
└─────────────────────┬─────────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│     Fly machine — LlmGateway.Assistant        │
│     (container, boots from the built image,   │
│      env = fly.toml [env] + decrypted secrets)│
│                                               │
│   /assistant/chat, /assistant/daily-summary   │
│   JWT validated against SupabaseAuth secret   │
└───┬───────────────┬───────────────┬───────────┘
    │               │               │
    ▼               ▼               ▼
Supabase        Google APIs      Anthropic / Gemini
Postgres        (Gmail, Calendar  (whichever Llm:Provider
(conversations, via GoogleOAuth   is configured)
 messages,      token stored in
 google_tokens) google_tokens)
```

## How a deploy actually works

Two things stay separate until a machine boots:

- **The image** — built from the repo's `Dockerfile`, contains code only, no secrets.
- **The secrets vault** — Fly's own encrypted store, populated by `flyctl secrets set`, independent of any deploy.

`flyctl deploy` → Fly's builder builds the image from `Dockerfile` → pushes it to Fly's registry → a machine boots that image, decrypts the current secrets, and merges them with the non-secret values in `fly.toml`'s `[env]` block to form the container's environment. Setting a secret alone (no code change) restarts the existing machine(s) with the new value — a full `flyctl deploy` isn't required just to rotate a secret.

ASP.NET Core reads environment variables using `__` (double underscore) as the config-section separator, so every `appsettings.json` key maps 1:1 to an env var name (e.g. `Anthropic:ApiKey` → `Anthropic__ApiKey`) — no code changes were needed to make secrets injectable this way.

## Files added

| File | Purpose |
|---|---|
| [`Dockerfile`](Dockerfile) | Multi-stage build — publishes only `LlmGateway.Assistant` (no dependency on `LlmGateway.Api`), listens on port 8080 |
| [`.dockerignore`](.dockerignore) | Keeps `bin/obj/tests/LlmGateway.Api` out of the build context |
| [`fly.toml`](fly.toml) | Fly app config: build source, non-secret env vars, health check against `/health` |

## Secrets (set via `flyctl secrets set`, never committed)

| Env var | Source |
|---|---|
| `Anthropic__ApiKey` | Anthropic console |
| `Gemini__ApiKey` | Google AI Studio (`aistudio.google.com/app/apikey`) |
| `Supabase__ConnectionString` | Supabase → Project Settings → Database → Connection string |
| `SupabaseAuth__JwtSecret` | Supabase → Project Settings → API → JWT Keys |
| `SupabaseAuth__Issuer` | `https://<project-ref>.supabase.co/auth/v1` |
| `GoogleOAuth__ClientId` / `GoogleOAuth__ClientSecret` | Google Cloud Console → APIs & Services → Credentials |
| `GoogleOAuth__RedirectUri` | The exact redirect URI registered on that OAuth client |

Non-secret tuning values (`Llm__Provider`, `DailySummary:*`) live directly in `fly.toml`'s `[env]` or `appsettings.json`'s defaults.

## Current state

- [x] `Dockerfile` / `.dockerignore` / `fly.toml` added, verified via a local `dotnet publish` + run against `/health`
- [x] Fly app `llm-gateway-prnhia` exists; `fly.toml` points at it
- [x] `Supabase__ConnectionString`, `SupabaseAuth__JwtSecret`, `SupabaseAuth__Issuer`, `GoogleOAuth__ClientId`, `GoogleOAuth__ClientSecret`, `GoogleOAuth__RedirectUri`, `Gemini__ApiKey` are set
- [ ] **`Anthropic__ApiKey` is not set yet** — `Llm__Provider` defaults to `Anthropic` in `fly.toml`, so until this is set (or `Llm__Provider` is switched to `Gemini`), LLM calls will fail even though the app itself is healthy
- [ ] No custom domain yet — `flyctl certs list` shows nothing; `api.tasktide.app` isn't pointed at Fly or certified
- [ ] `GoogleOAuthService.ExchangeCodeAsync`/`BuildAuthorizationUrl` exist but aren't wired to an HTTP route — nothing can actually complete the Google OAuth redirect yet
- [ ] A stray leftover secret `Gemini_Apikey` (typo'd name from an earlier attempt) is still set — harmless since nothing reads it, safe to remove with `flyctl secrets unset Gemini_Apikey`
- [ ] `fly.toml`'s `primary_region` says `iad`, but the two existing machines actually run in `ams` — cosmetic mismatch from an earlier manual `flyctl launch`, not a functional issue

## Common operations

```powershell
# Deploy after a code change
flyctl deploy -a llm-gateway-prnhia

# Set or rotate a secret (restarts machines automatically, no redeploy needed)
flyctl secrets set Anthropic__ApiKey="sk-ant-..." -a llm-gateway-prnhia

# Check machine/app health
flyctl status -a llm-gateway-prnhia
curl https://llm-gateway-prnhia.fly.dev/health

# Point a real domain at it (once ready)
flyctl certs add api.tasktide.app -a llm-gateway-prnhia
# then add the CNAME it gives you in Namecheap's DNS panel
```

## Verification

- `curl https://llm-gateway-prnhia.fly.dev/health` returns `200 {"status":"healthy", ...}`.
- Once `Anthropic__ApiKey` (or a switch to `Gemini`) is in place, a real `/assistant/daily-summary` call with a live Supabase JWT returns a generated summary, not a `502`.
