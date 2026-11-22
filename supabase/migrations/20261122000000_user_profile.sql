-- A small profile the chat assistant keeps for the user (CHAT_TOOLS_PLAN.md item 1b): the few lasting
-- preferences that make requests shorter ("lunch with Sam tomorrow" needs a time zone and a usual
-- length). It is changed only through an approved chat card, and read as the signed-in user, so
-- row-level security is the boundary: each user sees and changes only their own row.
create table if not exists public.user_profile (
  user_id                  uuid primary key references auth.users (id) on delete cascade,
  home_city                text check (home_city is null or char_length(home_city) between 1 and 80),
  default_meeting_minutes  int  check (default_meeting_minutes is null or default_meeting_minutes between 5 and 480),
  -- An IANA name like America/Los_Angeles; overrides the one the browser sends.
  time_zone                text check (time_zone is null or char_length(time_zone) between 1 and 64),
  updated_at               timestamptz not null default now()
);

alter table public.user_profile enable row level security;

drop policy if exists "own user profile" on public.user_profile;
create policy "own user profile" on public.user_profile
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
