// Postgres-backed TokenStore. It connects with SUPABASE_DB_URL, which bypasses row-level security,
// so every query is filtered by user_id and the code only ever runs two statements on one table:
// SELECT and UPDATE of google_tokens. That is exactly what the assistant_tokens database role is
// allowed to do (see supabase/migrations/20261116000000_google_tokens_server_only.sql).
import pg from "pg";
import type { StoredTokens, TokenStore } from "./tokenService.js";

interface Row {
  access_token: string;
  refresh_token: string;
  expires_at: Date;
}

export function createPgTokenStore(connectionString: string): TokenStore & { close(): Promise<void> } {
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

    close: () => pool.end(),
  };
}
