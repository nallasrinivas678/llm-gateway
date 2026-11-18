-- Let the Node assistant service save a user's Google tokens the first time they connect.
--
-- Until now the assistant_tokens role could only SELECT and UPDATE google_tokens (read a token and
-- store a refreshed one); the first-time "Connect Google" flow lived in the .NET gateway, which
-- connects as the table owner. Moving that flow to Node needs one more permission: INSERT.
--
-- Still true after this change: the role cannot DELETE, cannot touch any other table, and browsers
-- (anon / authenticated) still have no access to google_tokens. The existing policy
-- assistant_tokens_access already allows the role's rows (using (true) with check (true)); the
-- Node code only ever writes the row of the user whose login token it just verified.
--
-- Rollback:
--   revoke insert on public.google_tokens from assistant_tokens;

grant insert on public.google_tokens to assistant_tokens;
