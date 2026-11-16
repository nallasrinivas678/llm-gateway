# assistant-node

The Node.js (TypeScript) version of the TaskTide Assistant backend. It is being built to replace the .NET service in `src/LlmGateway.Assistant`, one feature at a time.

**Status: early.** The service starts, answers `/health`, checks a user's login token, and contains a Google tool server (Calendar, Gmail and Docs tools) with tests. It is not yet connected to a chat endpoint, and the three features below are not built.

| Feature | Today's home (.NET) | Planned here |
|---|---|---|
| Chat with tools (calendar, email, docs, tasks) | `POST /assistant/chat` | Phase 2-3 |
| Daily summary | `GET /assistant/daily-summary` | Phase 4 |
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
| `npm run build` | Compiles to the `dist` folder. |
| `npm start` | Runs the compiled build. |

Run `npm run typecheck` and `npm test` before every commit.

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

## What is an MCP server here?

An MCP server is a small program that offers tools to an AI agent. Ours, in `src/google-mcp`, offers calendar tools. The agent sees each tool's name, description and input rules, and decides when to call it. Rules we follow:

- The user's Google token is handed to the server for one request only and is never shared between users.
- Tool errors come back as short readable messages. Google's raw error text is not passed on.
- Google calls live in `calendar.ts`, `gmail.ts` and `docs.ts`, so they can be tested without MCP.
- There is no tool that sends email. `create_draft` saves a draft and the user sends it from Gmail.
- Text coming back from Gmail and Docs is data, not instructions. Tool descriptions say so.

## Secrets

`.env` holds your local secrets and is never committed. To put them on Fly, run this yourself from this folder (never paste secret values into chat or tickets):

```powershell
./scripts/set-fly-secrets.ps1 -App <your-fly-app>
```

It prints only the key names, asks you to confirm, and by default stages the secrets until the next `fly deploy`. Add `-Deploy` to apply them to running machines now.

## Not done yet

Reading and refreshing the user's Google token from Supabase, the chat agent and endpoint, daily summary, PDF Q&A, and CI. The Dockerfile and `fly.toml` have not been built or deployed (no Docker on the dev machine yet). These arrive in later phases of the plan.
