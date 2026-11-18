import { beforeEach, describe, expect, it, vi } from "vitest";

// Replace the real database driver with one that records what it was asked.
const pool = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn() }));
const poolOptions = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(options: unknown) {
        poolOptions.value = options;
        return pool;
      }
    },
  },
}));

import { createPgTokenStore } from "./pgTokenStore.js";

const url = "postgresql://assistant_tokens.ref:pw@pooler.example.com:6543/postgres";

beforeEach(() => {
  pool.query.mockReset();
  pool.end.mockReset();
});

describe("Postgres token store", () => {
  it("always connects with TLS", () => {
    createPgTokenStore(url);
    expect(poolOptions.value).toMatchObject({ connectionString: url, ssl: expect.anything() });
  });

  it("reads one user's tokens, filtered by user id, as parameters", async () => {
    const expiresAt = new Date("2026-11-18T10:00:00Z");
    pool.query.mockResolvedValue({ rows: [{ access_token: "a", refresh_token: "r", expires_at: expiresAt }] });

    const tokens = await createPgTokenStore(url).get("user-1");

    expect(tokens).toEqual({ accessToken: "a", refreshToken: "r", expiresAt });
    const [sql, params] = pool.query.mock.calls[0]!;
    expect(sql).toMatch(/from public\.google_tokens where user_id = \$1/);
    expect(params).toEqual(["user-1"]);
  });

  it("returns null when the user has no row", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect(await createPgTokenStore(url).get("user-1")).toBeNull();
  });

  it("saves a refreshed token for that user only, keeping the old refresh token when none is given", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const expiresAt = new Date("2026-11-18T11:00:00Z");

    await createPgTokenStore(url).saveRefreshed("user-1", "new-access", expiresAt);

    const [sql, params] = pool.query.mock.calls[0]!;
    expect(sql).toMatch(/where user_id = \$1/);
    expect(sql).toMatch(/coalesce\(\$4, refresh_token\)/);
    expect(params).toEqual(["user-1", "new-access", expiresAt, null]);
  });

  it("saves a new refresh token when Google sends one", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    await createPgTokenStore(url).saveRefreshed("user-1", "new-access", new Date(), "new-refresh");
    expect(pool.query.mock.calls[0]![1]).toContain("new-refresh");
  });

  it("only ever runs select and update (what the assistant_tokens role may do)", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const store = createPgTokenStore(url);
    await store.get("u");
    await store.saveRefreshed("u", "a", new Date());
    const verbs = pool.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0]!.toLowerCase());
    expect(verbs).toEqual(["select", "update"]);
  });

  it("closes the pool", async () => {
    await createPgTokenStore(url).close();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
