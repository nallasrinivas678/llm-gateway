# assistant-node

The Node.js (TypeScript) version of the TaskTide Assistant backend. It is being built to replace the .NET service in `src/LlmGateway.Assistant`, one feature at a time.

**Status: chat and the daily summary work; PDF Q&A is not built.** The service starts, checks a user's login token, serves `POST /assistant/chat` (a Gemini agent that can use the Google tools and remembers the conversation), serves the daily summary (`GET /assistant/daily-summary` and `/stream`), and has tests for all of it. PDF Q&A is still to come.

| Feature | Today's home (.NET) | Planned here |
|---|---|---|
| Chat with tools (calendar, email drafts, docs) | `POST /assistant/chat` | built (tasks and web search still to come) |
| Daily summary | `GET /assistant/daily-summary`, `/assistant/daily-summary/stream` | built |
| PDF question answering | `POST /assistant/docs`, `/assistant/docs/ask` | Phase 5 |

The full plan is in `PDF_QA_PLAN.md` and the approved migration plan (ask your lead for the link). Read it before picking up work.

## Words you will see

- **LangChain / LangGraph**: libraries that help an app talk to an AI model and let the model call tools. We will add them in Phase 2.
- **MCP (Model Context Protocol)**: a standard way to give an AI model tools, such as "list calendar events". Each tool set runs as an MCP server and our service connects to it.
- **JWT**: the signed login token the frontend sends with each request. Supabase issues it when a user signs in.
- **RLS (row-level security)**: a database rule that makes sure a user can only read their own rows.
- **Hono**: the small web framework we use. It works like Express.

## What you need

- Node.js 20 or newer (`node --version`)
- npm (comes with Node)
- A Supabase project to test against. Ask a teammate for the values in the table below.

## Run it

From this folder (`services/assistant-node`):

```bash
npm install
```

Create a file named `.env` in this folder (it is git-ignored, never commit it) with these settings:

| Variable | Required | What it is |
|---|---|---|
| `SUPABASE_JWT_ISSUER` | yes | Looks like `https://<project-ref>.supabase.co/auth/v1`. Used to check tokens. |
| `SUPABASE_JWT_SECRET` | no | Fallback key for tokens signed with a shared secret. |
| `CORS_ALLOWED_ORIGINS` | no | Websites allowed to call this service, separated by commas. Default `http://localhost:5173`. |
| `PORT` | no | Default `8080`. |
| `SUPABASE_ANON_KEY` | for chat | The project's public (publishable) key. Safe to share; the web app ships the same one. |
| `SUPABASE_URL` | no | Defaults to the host of `SUPABASE_JWT_ISSUER`. |
| `SUPABASE_DB_URL` | for chat | Database login for reading Google tokens (the narrow `assistant_tokens` role, URL form). See `.env.example`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for chat | Same Google OAuth client the .NET gateway uses; needed to refresh tokens. |
| `GOOGLE_API_KEY` | for chat | Gemini key. |

If a setting needed for chat is missing, the service still starts, logs which ones, and answers `503` on the chat endpoint.

Node does not read `.env` by itself in our scripts, so load it when you start:

```bash
node --env-file=.env --import tsx src/index.ts
```

Then check it works:

```bash
curl http://localhost:8080/health
```

You should see `{"status":"healthy", ...}`.

## Where settings live

Two places, one rule:

| Where | What goes there | Example |
|---|---|---|
| `config/default.json` (committed) | Anything that is not secret and is the same in every environment | Google API URLs, how many emails one search may return |
| Environment variables (`.env` locally, Fly secrets in production) | Secrets, and anything that differs per environment | `SUPABASE_DB_URL`, `GOOGLE_CLIENT_SECRET`, `PORT`, `CORS_ALLOWED_ORIGINS` |

If both set the same thing (`PORT`, `CORS_ALLOWED_ORIGINS`), the environment variable wins. A blank value such as `PORT=` counts as not set.

The file is checked when the service starts: a URL that is not `https`, a zero or negative limit, or a default bigger than its maximum stops startup with a clear error. After changing `config/default.json`, restart the service.

Stays in code on purpose: safety rules (which characters a Google Doc id may have, rejecting line breaks in email headers), fixed parts of Google's API requests, error wording, and the MCP server name.

**Rule for new code:** do not type a URL or a limit into a source file. Add it to `config/default.json` and to the schema in `src/config.ts`, then read it from the settings.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the service and restarts on file changes (set the variables in your shell first). |
| `npm run typecheck` | Checks the TypeScript for mistakes without running it. |
| `npm test` | Runs the automated tests. |
| `npm run test:coverage` | Runs the tests and fails if coverage drops below the floor in `vitest.config.ts` (90% lines, 75% branches). |
| `npm run build` | Compiles to the `dist` folder. |
| `npm start` | Runs the compiled build. |

Run `npm run typecheck` and `npm test` before every commit. The same checks run on every pull request (see below).

## How a request flows today

```
Browser (digital-garden)
   |  Authorization: Bearer <JWT>
   v
src/index.ts      starts the server
src/app.ts        builds the app: CORS, /health, and the /assistant routes
src/auth.ts       checks the JWT; on success stores userId for the route
   v
route handler     (only /assistant/whoami exists so far)
```

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point. Reads settings and starts the server. |
| `src/config.ts` | Reads `config/default.json` and the environment variables, checks both, and stops the service at startup if anything is wrong. Add new settings here. |
| `config/default.json` | Settings that are the same everywhere: Google API URLs, size limits, default port and allowed websites. No secrets. |
| `src/app.ts` | Creates the app and registers routes. New endpoints go here. |
| `src/auth.ts` | Login-token check. Mirrors the .NET `SupabaseJwtValidator`. |
| `src/auth.test.ts` | Tests for the token check. Copy its style for new tests. |
| `src/chat/chatService.ts` | One chat turn: load the conversation, connect the Google tools, run the agent, save the new messages. |
| `src/chat/conversationStore.ts` | Saves and loads conversations as the signed-in user, so the database's row rules decide who sees what. |
| `src/chat/messageMapper.ts` | Converts between stored message rows and LangChain messages (same format the .NET service writes). |
| `src/chat/mcpTools.ts` | Turns the Google MCP tools into tools the agent can call. |
| `src/chat/systemPrompt.ts` | The instructions the model gets on every request. |
| `src/wiring.ts` | Builds the real chat service from the settings at startup. |
| `src/google-mcp/calendar.ts`, `gmail.ts`, `docs.ts` | Plain functions that call the Google APIs. No MCP code here. |
| `src/google-mcp/common.ts` | The shared Google request helper and the two error types. |
| `src/google-mcp/server.ts` | The MCP server that exposes the six tools (`list_events`, `create_event`, `search_emails`, `create_draft`, `read_doc`, `append_to_doc`). One is built per request with that user's Google token. |
| `src/google-tokens/tokenService.ts` | Gives the rest of the service a valid Google token for a user, refreshing it when it is about to expire. |
| `src/google-tokens/pgTokenStore.ts` | Reads and updates the user's token row in Postgres (two queries, one table). |
| `src/google-mcp/server.test.ts` | Tests that talk to the server like the agent will, using a fake Google. |
| `tsconfig.json`, `tsconfig.build.json` | TypeScript settings. The build one leaves out test files. |
| `Dockerfile`, `fly.toml` | Packaging and Fly.io settings. Written but not deployed or run yet. |
| `.env.example` | Template for your `.env`. |
| `scripts/set-fly-secrets.ps1` | Copies your `.env` secrets to Fly (see below). |

## How tokens are checked

1. The request must have `Authorization: Bearer <token>`, otherwise the answer is 401.
2. The token must be issued by `SUPABASE_JWT_ISSUER` and not expired.
3. The signature is checked against the keys at `<issuer>/.well-known/jwks.json`. If that fails and `SUPABASE_JWT_SECRET` is set, the shared secret is tried.
4. The `sub` claim is the user's id. Routes read it with `c.get("userId")`.

Try it: `GET /assistant/whoami` with a valid token returns your user id.

## Adding an endpoint

1. Add a route in `src/app.ts` on the `assistant` router, so it is protected by login automatically.
2. Read the user with `c.get("userId")`. Never trust a user id sent in the request body.
3. Add a test next to it, using `app.request("/assistant/your-route", ...)` as in `src/auth.test.ts`.
4. Run `npm run typecheck` and `npm test`.

## Rules for this project

- **Keep it simple.** Do not add layers or abstractions before they are needed.
- **Branches** are named `srnalla-<featureName>`.
- **Secrets** never go in the code or in git. Locally use `.env`; in production use Fly secrets.
- **Users only see their own data.** Database calls must run with the signed-in user's token so RLS applies. Do not use a service-role key for user requests.
- Treat email and document text as untrusted: it may contain instructions meant to trick the AI.

## The chat endpoint

`POST /assistant/chat` (needs the `Authorization: Bearer <Supabase login token>` header). Same request and response as the .NET service:

```json
{ "conversationId": "optional uuid, leave out to start a new conversation", "message": "What is on my calendar tomorrow?" }
```

```json
{ "conversationId": "uuid", "reply": "You have ...", "toolCallsExecuted": ["list_events"] }
```

What happens on each request:

1. The login token is checked (`src/auth.ts`). The user's own token is then used to talk to Supabase, so the database refuses anything that is not theirs. Another user's `conversationId` gives `404`.
2. Earlier messages of the conversation are loaded.
3. The user's Google token is fetched (and refreshed if needed) and the Google tools are connected. If Google is not connected, the chat still works but the model is told it has no calendar, email or document tools.
4. The agent (Gemini, see `config/default.json` > `chat`) answers, calling tools as needed, up to 5 tool rounds. If it keeps going, the user gets a polite "I couldn't finish that" reply instead of an error.
5. The new messages are saved in one database insert, and the reply is returned.

Errors: `400` bad request body, `401` no or bad login token, `404` conversation not found, `502` something failed inside (a generic message; details are only in the server log), `503` chat is switched off because a needed secret is missing (the startup log lists which).

Tool names changed from .NET (for example `list_events` instead of `list_upcoming_calendar_events`), so `toolCallsExecuted` shows the new names.

## The daily summary endpoints

Both need the same `Authorization: Bearer <Supabase login token>` header and give the same data as the .NET service.

- `GET /assistant/daily-summary` returns `{ summary, emails: [{category, subject, from, date}], events: [{summary, start, end}], generatedAtUtc }`.
- `GET /assistant/daily-summary/stream` sends Server-Sent Events: `status` (`{message}`), `chunk` (`{text}`, the summary as it is written), then `done` (the same object the JSON endpoint returns). On failure it sends `error` (`{detail}`).

How it works (`src/dailySummary/dailySummaryService.ts`): it is not an agent. Fixed code runs the three Gmail searches (orders, bills, travel; the queries are in `config/default.json` > `dailySummary`) and the Calendar read at the same time, then makes one Gemini call that writes the briefing. Email text is flattened to one line each and the prompt says it is data, not instructions. The result is cached for 15 minutes per user, in memory, so run one machine. The JSON endpoint gives the model 25 seconds and one retry; the streaming one has no retry, because text may already have reached the browser.

Errors: `401` no or bad login token, `502` with `{detail}` (for example "Google account is not connected"; other failures give a generic message and the details only go to the server log), `503` when the needed secrets are missing. Chat does not need to be configured for the summary to work: the summary needs everything chat needs except `SUPABASE_ANON_KEY`.

## What is an MCP server here?

An MCP server is a small program that offers tools to an AI agent. Ours, in `src/google-mcp`, offers calendar tools. The agent sees each tool's name, description and input rules, and decides when to call it. Rules we follow:

- The user's Google token is handed to the server for one request only and is never shared between users.
- Tool errors come back as short readable messages. Google's raw error text is not passed on.
- Google calls live in `calendar.ts`, `gmail.ts` and `docs.ts`, so they can be tested without MCP.
- There is no tool that sends email. `create_draft` saves a draft and the user sends it from Gmail.
- Text coming back from Gmail and Docs is data, not instructions. Tool descriptions say so.

## Checks and deploys (GitHub Actions)

Workflows live in `.github/workflows` at the repository root. They only run when something under `services/assistant-node` changes.

| Workflow | When | What it does |
|---|---|---|
| `assistant-node-ci.yml` | every pull request, and pushes to `main` | Typecheck, tests with the coverage floor, build, `npm audit` for high-severity problems in the shipped packages. A second job builds the Docker image, starts it and checks `/health`. |
| `assistant-node-deploy.yml` | push to `main`, or "Run workflow" by hand | Typecheck, tests, then `flyctl deploy --remote-only` (built on Fly, no Docker needed in CI). A failed `/health` check on the new version keeps the old one running. |

The deploy workflow is **off until you switch it on**, so a missing Fly app never shows as a red build:

1. Create the app once and set its secrets (see Secrets below).
2. Create a deploy token (`fly tokens create deploy -a <your-fly-app>`) and save it as the repository secret `FLY_API_TOKEN`.
3. Set the repository variable `ASSISTANT_NODE_DEPLOY` to `true`. Optionally add required reviewers to the `production` environment so a person approves each deploy.

Secrets for the service itself are not set by CI. They go to Fly with the script below, so no application secret is stored in GitHub. Dependabot opens a weekly pull request for npm and Actions updates.

## Secrets

`.env` holds your local secrets and is never committed. To put them on Fly, run this yourself from this folder (never paste secret values into chat or tickets):

```powershell
./scripts/set-fly-secrets.ps1 -App <your-fly-app>
```

It prints only the key names, asks you to confirm, and by default stages the secrets until the next `fly deploy`. Add `-Deploy` to apply them to running machines now.

## Not done yet

Task and web search tools, approval before the assistant changes anything, PDF Q&A, and CI. Saving conversations has been tested against a fake database, and the database's security rules were checked separately, but not yet end to end with a real signed-in user. The Dockerfile and `fly.toml` have not been built or deployed (no Docker on the dev machine yet). See `CHECKLIST.md`.
