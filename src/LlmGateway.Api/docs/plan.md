# TaskTide AI Assistant — Implementation Plan

This plan covers: Supabase schema, llm-gateway.assistant (.NET) project structure, chat flow, connectors (Gmail/Calendar/Docs), and AKS deployment.

---

## 1. Supabase Schema

Run these in the Supabase SQL editor (or as migration files). All tables use `user_id` referencing `auth.users(id)` and rely on Supabase Auth for identity.

```sql
-- ============================================
-- Conversations & Messages
-- ============================================
create table conversations (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    title text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table messages (
    id uuid primary key default gen_random_uuid(),
    conversation_id uuid not null references conversations(id) on delete cascade,
    role text not null check (role in ('user', 'assistant', 'tool')),
    content text not null,
    tool_call_id text,          -- set when role = 'tool' (links to the tool call it answers)
    tool_calls jsonb,           -- set when role = 'assistant' and it requested tool calls
    created_at timestamptz not null default now()
);

create index idx_messages_conversation_id on messages(conversation_id);
create index idx_conversations_user_id on conversations(user_id);

-- ============================================
-- User Profile (for job-application agent)
-- ============================================
create table user_profiles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    full_name text,
    email text,
    phone text,
    address_line1 text,
    address_line2 text,
    city text,
    state text,
    zip_code text,
    resume_url text,            -- Supabase Storage URL to resume PDF/doc
    resume_text text,           -- extracted plain text for LLM tailoring
    linkedin_url text,
    updated_at timestamptz not null default now()
);

-- ============================================
-- Google OAuth Tokens (Gmail / Calendar / Docs)
-- ============================================
create table google_tokens (
    user_id uuid primary key references auth.users(id) on delete cascade,
    access_token text not null,      -- encrypt at rest (see note below)
    refresh_token text not null,     -- encrypt at rest
    scopes text not null,            -- space-separated granted scopes
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ============================================
-- Job Applications (tracking agent-assisted applications)
-- ============================================
create table job_applications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    job_url text not null,
    company text,
    job_title text,
    status text not null default 'draft' check (status in ('draft', 'tailored', 'applied', 'rejected', 'interview')),
    tailored_resume_text text,
    tailored_cover_letter text,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index idx_job_applications_user_id on job_applications(user_id);

-- ============================================
-- Row Level Security (RLS)
-- ============================================
-- Enable RLS on all user-data tables. llm-gateway connects with the
-- service_role key which BYPASSES RLS (server is trusted) — RLS here
-- protects direct client (mobile app) access via Supabase client SDK.

alter table conversations enable row level security;
alter table messages enable row level security;
alter table user_profiles enable row level security;
alter table google_tokens enable row level security;
alter table job_applications enable row level security;

create policy "Users can access own conversations"
    on conversations for all
    using (auth.uid() = user_id);

create policy "Users can access own messages"
    on messages for all
    using (
        conversation_id in (
            select id from conversations where user_id = auth.uid()
        )
    );

create policy "Users can access own profile"
    on user_profiles for all
    using (auth.uid() = user_id);

create policy "Users can access own google tokens"
    on google_tokens for all
    using (auth.uid() = user_id);

create policy "Users can access own job applications"
    on job_applications for all
    using (auth.uid() = user_id);
```

**Notes:**
- `google_tokens.access_token` / `refresh_token`: encrypt at the application layer before insert (e.g., AES via a key in Key Vault), or use Supabase Vault (`supabase_vault` extension) if available on your plan.
- `resume_text` is a denormalized plain-text copy for fast LLM prompt injection — keep `resume_url` as the source of truth (PDF in Supabase Storage).

---

## 2. llm-gateway.assistant — .NET Project Structure

```
LlmGateway.sln
├── LlmGateway.Api                 (existing gateway)
└── LlmGateway.Assistant           (NEW)
    ├── Orchestrator/
    │   ├── ChatOrchestrator.cs
    │   ├── ConversationSession.cs
    │   └── ToolCallDispatcher.cs
    ├── Tools/
    │   ├── ITool.cs
    │   ├── IToolRegistry.cs / ToolRegistry.cs
    │   ├── TaskTools.cs
    │   ├── WebSearchTool.cs
    │   ├── GmailTools.cs
    │   ├── GoogleCalendarTools.cs
    │   ├── GoogleDocsTools.cs
    │   └── JobApplicationTools.cs
    ├── Connectors/
    │   ├── SupabaseDataService.cs     (Npgsql-based DB access)
    │   ├── GoogleOAuthService.cs
    │   ├── GmailConnector.cs
    │   ├── CalendarConnector.cs
    │   └── DocsConnector.cs
    ├── Providers/
    │   ├── ILlmProvider.cs
    │   ├── AnthropicProvider.cs
    │   └── GeminiProvider.cs
    ├── Models/
    │   ├── ChatMessage.cs
    │   ├── ChatRequest.cs / ChatResponse.cs
    │   ├── ToolCallRequest.cs / ToolResult.cs
    │   └── ToolSchema.cs
    ├── Auth/
    │   └── SupabaseJwtValidator.cs
    └── Endpoints/
        └── ChatController.cs
```

### Build order
1. `ITool` interface + `ToolRegistry` — the shared contract every tool implements.
2. `SupabaseDataService` (Npgsql) — read/write `conversations`, `messages`, `user_profiles`.
3. `TaskTools` (Create/List/Complete/Reschedule) — wraps TaskTide's existing `tasks` table.
4. `ChatOrchestrator` loop (message → LLM → tool calls → LLM → response) with `AnthropicProvider` or `GeminiProvider`.
5. `SupabaseJwtValidator` — validate the mobile app's Supabase JWT on every request.
6. `ChatController` — `POST /assistant/chat` endpoint.
7. `WebSearchTool` — use provider-native web search/grounding (Anthropic or Gemini) first; custom News API only if needed.
8. `GoogleOAuthService` + `CalendarConnector` — first Google integration (simplest surface).
9. `GmailConnector`, `DocsConnector` — added incrementally, same OAuth service.
10. `JobApplicationTools` — reads `user_profiles`, writes `job_applications`, drafts tailored resume/cover letter text via LLM (no auto-submit in v1).

---

## 3. Mobile App Integration (TaskTide)

### Config to add
- `ASSISTANT_API_BASE_URL` (e.g., `https://api.tasktide.app` once deployed)
- Reuse existing Supabase JWT from TaskTide's auth session — no new login flow needed.

### New chat screen — request shape
```json
POST /assistant/chat
Authorization: Bearer <supabase-jwt>
Content-Type: application/json

{
  "conversationId": "uuid-or-null",
  "message": "What are today's top news?"
}
```

### Response shape
```json
{
  "conversationId": "uuid",
  "reply": "Here are today's top stories: ...",
  "toolCallsExecuted": ["web_search"]
}
```

### Client-side tasks
- New `ChatScreen` component with message list + input (mirrors your existing task list UI style).
- Store `conversationId` locally (AsyncStorage) to resume the thread.
- Optional: local optimistic UI — append user message immediately, show a loading indicator until response returns.

---

## 4. AKS Deployment Plan

### Phase 1 — Containerize
- `Dockerfile` (multi-stage: SDK build → ASP.NET runtime image) in `LlmGateway.Assistant/`.
- Validate locally: `docker build -t llm-gateway-assistant .` then `docker run -p 8080:8080 ...`.

### Phase 2 — Azure resources
- **Azure Container Registry (ACR)** — image storage.
- **AKS cluster** — start with a small burstable node pool (e.g., `Standard_B2s`, 1–2 nodes).
- **Azure Key Vault** — store: Anthropic/Gemini API keys, Supabase service_role connection string, Google OAuth client secret, JWT signing secret.
- **Key Vault CSI driver** — mounts secrets into pods as files/env vars, no secrets in manifests or source.

### Phase 3 — Kubernetes manifests
- `Deployment` — 2 replicas of the assistant API.
- `Service` (ClusterIP) + `Ingress` (NGINX ingress controller or Azure Application Gateway) for TLS + external routing.
- `HorizontalPodAutoscaler` — scale on CPU/request volume.
- `SecretProviderClass` — wires Key Vault secrets into the pod.

### Phase 4 — CI/CD
- GitHub Actions workflow: on push to `main` →
  1. `dotnet build` + test
  2. `docker build` + push to ACR
  3. `kubectl set image` / `helm upgrade` to AKS

### Phase 5 — Observability
- Azure Monitor + Container Insights for logs/metrics on the AKS cluster.

### Sequencing recommendation
Get the orchestrator + chat loop fully working on a simpler host first (Azure App Service or even local + ngrok for TestFlight testing), **then** migrate to AKS once the application logic is stable. Debugging app logic and K8s infra simultaneously slows both down.

---

## 5. Milestone Checklist

- [ ] Run Supabase schema migration (Section 1)
- [ ] Scaffold `LlmGateway.Assistant` project + `ITool`/`ToolRegistry`
- [ ] Implement `SupabaseDataService` (Npgsql) for conversations/messages
- [ ] Implement `TaskTools` + validate one full tool-call round trip
- [ ] Implement `ChatOrchestrator` + pick LLM provider (Anthropic or Gemini)
- [ ] Add Supabase JWT validation middleware
- [ ] Stand up `POST /assistant/chat` endpoint
- [ ] Wire TaskTide mobile chat screen to the endpoint
- [ ] Add `WebSearchTool` (provider-native search/grounding)
- [ ] Add Google OAuth + Calendar connector
- [ ] Add Gmail + Docs connectors
- [ ] Add `JobApplicationTools` (draft-only, no auto-submit)
- [ ] Dockerize `LlmGateway.Assistant`
- [ ] Deploy to Azure App Service (validation stage)
- [ ] Provision AKS + ACR + Key Vault
- [ ] Write K8s manifests + CI/CD pipeline
- [ ] Migrate from App Service to AKS
- [ ] Add observability (Container Insights)
