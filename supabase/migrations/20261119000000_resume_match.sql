-- Resume match: score a resume against a job description, round by round.
-- assistant-node reads and writes these tables with the signed-in user's own token, so
-- row-level security is the boundary: each user sees and changes only their own rows.

create table if not exists public.resume_matches (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  title         text not null,
  job_url       text,
  job_text      text not null,
  -- Built once per job and never changed, so every round is scored against the same list:
  -- [{ "id": 1, "text": "5+ years C#", "kind": "must" | "nice" }]
  requirements  jsonb not null,
  target_score  int not null default 90 check (target_score between 1 and 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.resume_versions (
  id            uuid primary key default gen_random_uuid(),
  match_id      uuid not null references public.resume_matches (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  version       int not null check (version >= 1),
  resume_text   text not null,
  score         int not null check (score between 0 and 100),
  -- [{ "requirementId": 1, "status": "met" | "partial" | "missing", "evidence": "quoted line" }]
  results       jsonb not null,
  -- The skills the user confirmed for the rewrite that produced this version (empty for version 1).
  confirmed     jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  unique (match_id, version)
);

create index if not exists resume_matches_user_idx on public.resume_matches (user_id, created_at desc);
create index if not exists resume_versions_user_idx on public.resume_versions (user_id);

alter table public.resume_matches enable row level security;
alter table public.resume_versions enable row level security;

drop policy if exists "own resume matches" on public.resume_matches;
create policy "own resume matches" on public.resume_matches
  for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- A version may only be added to a match the same user owns.
drop policy if exists "own resume versions" on public.resume_versions;
create policy "own resume versions" on public.resume_versions
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (select 1 from public.resume_matches m where m.id = match_id and m.user_id = (select auth.uid()))
  );

-- Reuse the shared updated_at trigger function when the base schema created it.
do $$
begin
  if exists (select 1 from pg_proc where proname = 'set_updated_at') then
    drop trigger if exists resume_matches_updated_at on public.resume_matches;
    create trigger resume_matches_updated_at before update on public.resume_matches
      for each row execute function set_updated_at();
  end if;
end $$;
