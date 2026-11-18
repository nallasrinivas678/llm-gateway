-- Google tokens: server-side access only.
--
-- Problem: the policy "Users can access own google tokens" (ALL, role public, auth.uid() = user_id)
-- lets a signed-in browser read, change and delete its own row, including the Google refresh token.
-- The frontend never uses this table, so a cross-site scripting bug would be the only thing that
-- ever reads it from the browser.
--
-- Fix:
--   1. Remove the browser-facing policy and revoke the table from anon/authenticated.
--      RLS stays enabled, so there is no accidental way back in.
--   2. Add a narrow role, assistant_tokens, for the Node assistant service. It can only
--      SELECT and UPDATE google_tokens (read a token, store a refreshed one).
--
-- Not affected: the .NET gateway and the Google OAuth callback connect with the table owner /
-- service connection, which is not governed by these grants or by RLS.
--
-- The role is created NOLOGIN on purpose: no password belongs in git. After applying, set one
-- yourself in the Supabase SQL editor (see the end of this file) and put the resulting
-- connection string in SUPABASE_DB_URL.
--
-- Rollback (restores the old browser access; only do this if something depends on it):
--   create policy "Users can access own google tokens" on public.google_tokens
--     for all to public using (auth.uid() = user_id);
--   grant select, insert, update, delete on public.google_tokens to anon, authenticated;
--   drop policy if exists assistant_tokens_access on public.google_tokens;
--   revoke all on public.google_tokens from assistant_tokens;

drop policy if exists "Users can access own google tokens" on public.google_tokens;

alter table public.google_tokens enable row level security;

revoke all on public.google_tokens from anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'assistant_tokens') then
    create role assistant_tokens nologin;
  end if;
end
$$;

grant usage on schema public to assistant_tokens;
revoke all on public.google_tokens from assistant_tokens;
grant select, update on public.google_tokens to assistant_tokens;

-- The role is not BYPASSRLS, so it needs a policy. The grants above limit it to SELECT and UPDATE;
-- the Node code filters every query by the signed-in user's id.
drop policy if exists assistant_tokens_access on public.google_tokens;
create policy assistant_tokens_access on public.google_tokens
  for all to assistant_tokens
  using (true)
  with check (true);

-- After applying, run this yourself in the Supabase SQL editor (replace the password; never commit it):
--   alter role assistant_tokens with login password '<a long random password>';
-- Then use the pooler connection string with user "assistant_tokens.<project-ref>" as SUPABASE_DB_URL.
