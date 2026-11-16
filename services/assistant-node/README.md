# assistant-node

The Node.js (TypeScript) version of the TaskTide Assistant backend. It is being built to replace the .NET service in `src/LlmGateway.Assistant`, one feature at a time.

**Status: early.** The service starts, answers `/health`, checks a user's login token, and contains the first Google tool server (Calendar) with tests. It is not yet connected to a chat endpoint, and the three features below are not built.

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
| `src/config.ts` | Reads and checks environment variables. Add new settings here. |
| `src/app.ts` | Creates the app and registers routes. New endpoints go here. |
| `src/auth.ts` | Login-token check. Mirrors the .NET `SupabaseJwtValidator`. |
| `src/auth.test.ts` | Tests for the token check. Copy its style for new tests. |
| `src/google-mcp/calendar.ts` | Plain functions that call the Google Calendar API. No MCP code here. |
| `src/google-mcp/server.ts` | The MCP server that exposes `list_events` and `create_event` as tools. One is built per request with that user's Google token. |
| `src/google-mcp/server.test.ts` | Tests that talk to the server like the agent will, using a fake Google. |
| `tsconfig.json`, `tsconfig.build.json` | TypeScript settings. The build one leaves out test files. |
| `Dockerfile`, `fly.toml` | Packaging and Fly.io settings. Written but not deployed or run yet. |
| `.env.example` | Template for your `.env`. |

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
- Google calls live in `calendar.ts`, so they can be tested without MCP.

## Not done yet

Gmail and Docs tools, reading and refreshing the user's Google token from Supabase, the chat agent and endpoint, daily summary, PDF Q&A, and CI. The Dockerfile and `fly.toml` have not been built or deployed (no Docker on the dev machine yet). These arrive in later phases of the plan.
