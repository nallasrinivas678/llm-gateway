-- Agent harness (AGENT_HARNESS_PLAN.md A2 and A3): approval before the chat assistant changes
-- anything, and a record of each run. assistant-node reads and writes both tables with the
-- signed-in user's own token, so row-level security is the boundary: each user sees only their own.

-- A2. A change the assistant proposed. Write tools save a row here instead of running; the user's
-- approval runs exactly these stored arguments (not a second model call).
create table if not exists public.agent_actions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  tool             text not null check (char_length(tool) between 1 and 64),
  -- The checked arguments, as the tool will receive them.
  args             jsonb not null,
  -- Plain words for the approval card, e.g. "Add task 'Call the dentist' due Fri 22 Nov".
  preview          text not null check (char_length(preview) between 1 and 500),
  -- pending -> running -> done | failed, or pending -> rejected. "running" is claimed with a
  -- conditional update, so a double click cannot run the same action twice.
  status           text not null default 'pending'
                   check (status in ('pending', 'running', 'done', 'failed', 'rejected')),
  -- A short readable outcome for the user (never a raw error from Google or the database).
  result           text check (result is null or char_length(result) <= 500),
  created_at       timestamptz not null default now(),
  -- Approving after this fails with a clear message; the row is kept for the record.
  expires_at       timestamptz not null default now() + interval '1 day',
  decided_at       timestamptz
);

create index if not exists agent_actions_user_pending_idx on public.agent_actions (user_id, status, created_at desc);
create index if not exists agent_actions_conversation_idx on public.agent_actions (conversation_id);

alter table public.agent_actions enable row level security;

-- The owner may read and change their own rows. Changing one directly (outside the assistant) gains
-- nothing: every tool already acts as the user, with the user's own rights.
drop policy if exists "own agent actions" on public.agent_actions;
create policy "own agent actions" on public.agent_actions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid()))
  );

-- A3. One row per chat turn, to answer "how slow is it", "which tool fails", "how often does it hit
-- the step limit". No message text and no tool arguments: the conversation already holds the
-- messages, and personal content stays out of the record.
create table if not exists public.agent_runs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  -- Kept when the conversation is deleted, since the row holds nothing personal.
  conversation_id  uuid references public.conversations (id) on delete set null,
  started_at       timestamptz not null default now(),
  duration_ms      int not null check (duration_ms >= 0),
  model            text not null,
  steps            int not null check (steps >= 0),
  -- [{ "name": "list_events", "ms": 412, "ok": true }, { "name": "web_search", "ms": 20000, "ok": false, "code": "timeout" }]
  tool_calls       jsonb not null default '[]'::jsonb,
  outcome          text not null check (outcome in ('ok', 'step_limit', 'timeout', 'error')),
  -- Proposed actions saved during the run (A2), so approval rates can be counted later.
  actions_proposed int not null default 0 check (actions_proposed >= 0)
);

create index if not exists agent_runs_user_idx on public.agent_runs (user_id, started_at desc);

alter table public.agent_runs enable row level security;

-- Written once by the service as the user, then only read. No update or delete policy, so a row
-- cannot be changed afterwards; it goes when the user's account is deleted.
drop policy if exists "own agent runs read" on public.agent_runs;
create policy "own agent runs read" on public.agent_runs
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "own agent runs insert" on public.agent_runs;
create policy "own agent runs insert" on public.agent_runs
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and (conversation_id is null
         or exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())))
  );
