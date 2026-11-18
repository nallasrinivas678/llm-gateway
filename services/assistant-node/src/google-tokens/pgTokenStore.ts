// Postgres-backed TokenStore. It connects with SUPABASE_DB_URL, which bypasses row-level security,
// so every query is filtered by user_id and the code only ever runs two statements on one table:
// SELECT, UPDATE and (for a first-time connect) INSERT of google_tokens. That is exactly what the
// assistant_tokens database role is allowed to do (see supabase/migrations/20261116000000_google_tokens_server_only.sql
// and 20261118000000_assistant_tokens_insert.sql). It cannot delete.
import pg from "pg";
import type { ConnectedTokens, ConnectStore } from "../google-oauth/connectService.js";
import type { StoredTokens, TokenStore } from "./tokenService.js";

interface Row {
  access_token: string;
  refresh_token: string;
  expires_at: Date;
}

export function createPgTokenStore(connectionString: string): TokenStore & ConnectStore & { close(): Promise<void> } {
  // Supabase's pooler runs in transaction mode: no named prepared statements are used here, and
  // every call is a single statement, so nothing depends on session state.
  // TLS is always on: without it the pooler accepts a plain-text connection and tokens would cross
  // the network unencrypted. Supabase's certificate chain is not in Node's trust store, so the
  // certificate itself is not verified yet (encrypted, but open to an impersonating server).
  // TODO before production: download Supabase's CA certificate and pass it as `ssl: { ca }`.
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  return {
    async get(userId): Promise<StoredTokens | null> {
      const result = await pool.query<Row>(
        "select access_token, refresh_token, expires_at from public.google_tokens where user_id = $1",
        [userId],
      );
      const row = result.rows[0];
      return row ? { accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: row.expires_at } : null;
    },

    async saveRefreshed(userId, accessToken, expiresAt, newRefreshToken): Promise<void> {
      await pool.query(
        `update public.google_tokens
            set access_token = $2,
                expires_at = $3,
                refresh_token = coalesce($4, refresh_token),
                updated_at = now()
          where user_id = $1`,
        [userId, accessToken, expiresAt, newRefreshToken ?? null],
      );
    },

    // First-time connect (or a reconnect): insert, or replace what is there. Always for one user id.
    async saveConnected(userId: string, tokens: ConnectedTokens): Promise<void> {
      await pool.query(
        `insert into public.google_tokens (user_id, access_token, refresh_token, scopes, expires_at, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (user_id) do update set
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           scopes = excluded.scopes,
           expires_at = excluded.expires_at,
           updated_at = now()`,
        [userId, tokens.accessToken, tokens.refreshToken, tokens.scopes, tokens.expiresAt],
      );
    },

    close: () => pool.end(),
  };
}
