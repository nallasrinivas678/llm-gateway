import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { MatchNotFoundError, VersionConflictError } from "./errors.js";
import { createSupabaseMatchStore } from "./matchStore.js";

interface Call {
  table: string;
  op: "select" | "insert" | "delete";
  payload?: unknown;
  filters: Record<string, unknown>;
}

type Answer = { data: unknown; error: { code: string } | null };

// A tiny stand-in for the supabase-js query builder: records each call and answers from `respond`.
function fakeSupabase(respond: (call: Call) => Answer) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: {} };
      calls.push(call);
      const run = () => Promise.resolve(respond(call));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        insert: (payload: unknown) => ((call.op = "insert"), (call.payload = payload), chain),
        delete: () => ((call.op = "delete"), chain),
        eq: (key: string, value: unknown) => ((call.filters[key] = value), chain),
        order: () => chain,
        limit: () => chain,
        single: run,
        maybeSingle: run,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject),
      };
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const match = { title: "Job", jobUrl: null, jobText: "text", requirements: [{ id: 1, text: "C#", kind: "must" as const }], targetScore: 90 };
const first = { version: 1, resumeText: "resume", score: 50, results: [], confirmed: [] };
const ok = (data: unknown = null): Answer => ({ data, error: null });

describe("Supabase match store", () => {
  it("saves the match and its first version for the caller", async () => {
    const { client, calls } = fakeSupabase((call) => (call.table === "resume_matches" ? ok({ id: "m1" }) : ok()));
    const id = await createSupabaseMatchStore(client, "u1").createMatch(match, first);

    expect(id).toBe("m1");
    expect(calls[0]).toMatchObject({ table: "resume_matches", op: "insert", payload: { user_id: "u1", title: "Job", job_url: null, target_score: 90 } });
    expect(calls[1]).toMatchObject({ table: "resume_versions", op: "insert", payload: { match_id: "m1", user_id: "u1", version: 1, resume_text: "resume", score: 50 } });
  });

  it("removes the match again when saving the version fails", async () => {
    const { client, calls } = fakeSupabase((call) =>
      call.table === "resume_versions" ? { data: null, error: { code: "42501" } } : ok(call.op === "insert" ? { id: "m1" } : null),
    );
    await expect(createSupabaseMatchStore(client, "u1").createMatch(match, first)).rejects.toThrow("42501");
    expect(calls[2]).toMatchObject({ table: "resume_matches", op: "delete", filters: { id: "m1" } });
  });

  it("reports a failed match insert with its code", async () => {
    const { client } = fakeSupabase(() => ({ data: null, error: { code: "23502" } }));
    await expect(createSupabaseMatchStore(client, "u1").createMatch(match, first)).rejects.toThrow("23502");
  });

  it("adds a version for the caller to an existing match", async () => {
    const { client, calls } = fakeSupabase(() => ok());
    await createSupabaseMatchStore(client, "u1").addVersion("m1", { ...first, version: 2, confirmed: [{ requirementId: 3, detail: "d" }] });
    expect(calls[0]).toMatchObject({
      table: "resume_versions",
      op: "insert",
      payload: { match_id: "m1", user_id: "u1", version: 2, confirmed: [{ requirementId: 3, detail: "d" }] },
    });
  });

  it("reports a version number that is already taken as a conflict, and other failures with their code", async () => {
    const taken = fakeSupabase(() => ({ data: null, error: { code: "23505" } }));
    await expect(createSupabaseMatchStore(taken.client, "u1").addVersion("m1", first)).rejects.toBeInstanceOf(VersionConflictError);
    const other = fakeSupabase(() => ({ data: null, error: { code: "42501" } }));
    await expect(createSupabaseMatchStore(other.client, "u1").addVersion("m1", first)).rejects.toThrow("42501");
  });

  it("reads one match with its versions in order", async () => {
    const row = {
      id: "m1",
      title: "Job",
      job_url: "https://x.example",
      job_text: "text",
      requirements: match.requirements,
      target_score: 90,
      created_at: "t0",
      resume_versions: [
        { version: 2, resume_text: "v2", score: 80, results: [], confirmed: [{ requirementId: 1, detail: "d" }], created_at: "t2" },
        { version: 1, resume_text: "v1", score: 50, results: [], confirmed: [], created_at: "t1" },
      ],
    };
    const { client, calls } = fakeSupabase(() => ok(row));
    const stored = await createSupabaseMatchStore(client, "u1").getMatch("m1");

    expect(calls[0]!.filters).toEqual({ id: "m1" });
    expect(stored).toMatchObject({ id: "m1", jobUrl: "https://x.example", targetScore: 90 });
    expect(stored.versions.map((v) => [v.version, v.resumeText])).toEqual([[1, "v1"], [2, "v2"]]);
  });

  it("treats a match it cannot see (missing or another user's) as not found", async () => {
    const { client } = fakeSupabase(() => ok(null));
    await expect(createSupabaseMatchStore(client, "u1").getMatch("m1")).rejects.toBeInstanceOf(MatchNotFoundError);
  });

  it("lists matches with their latest score", async () => {
    const rows = [
      { id: "m2", title: "B", job_url: null, created_at: "t2", resume_versions: [{ version: 1, score: 40 }, { version: 2, score: 75 }] },
      { id: "m1", title: "A", job_url: null, created_at: "t1", resume_versions: [] },
    ];
    const { client } = fakeSupabase(() => ok(rows));
    expect(await createSupabaseMatchStore(client, "u1").listMatches()).toEqual([
      { id: "m2", title: "B", jobUrl: null, createdAt: "t2", latestVersion: 2, latestScore: 75 },
      { id: "m1", title: "A", jobUrl: null, createdAt: "t1", latestVersion: 0, latestScore: null },
    ]);
  });

  it("reports read failures with their code", async () => {
    const { client } = fakeSupabase(() => ({ data: null, error: { code: "PGRST301" } }));
    const store = createSupabaseMatchStore(client, "u1");
    await expect(store.getMatch("m1")).rejects.toThrow("PGRST301");
    await expect(store.listMatches()).rejects.toThrow("PGRST301");
  });
});
