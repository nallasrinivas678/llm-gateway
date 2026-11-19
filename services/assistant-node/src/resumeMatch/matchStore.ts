// Saves and loads resume matches as the signed-in user. The Supabase client carries the user's own
// token, so row-level security decides what they can see: another user's match is invisible.
import type { SupabaseClient } from "@supabase/supabase-js";
import { MatchNotFoundError, VersionConflictError } from "./errors.js";
import type { Requirement, RequirementResult } from "./scoring.js";

export interface ConfirmedSkill {
  requirementId: number;
  detail: string;
}

export interface StoredVersion {
  version: number;
  resumeText: string;
  score: number;
  results: RequirementResult[];
  confirmed: ConfirmedSkill[];
  createdAt: string;
}

export interface StoredMatch {
  id: string;
  title: string;
  jobUrl: string | null;
  jobText: string;
  requirements: Requirement[];
  targetScore: number;
  createdAt: string;
  versions: StoredVersion[];
}

export interface MatchSummary {
  id: string;
  title: string;
  jobUrl: string | null;
  createdAt: string;
  latestVersion: number;
  latestScore: number | null;
}

export interface NewMatch {
  title: string;
  jobUrl: string | null;
  jobText: string;
  requirements: Requirement[];
  targetScore: number;
}

export interface NewVersion {
  version: number;
  resumeText: string;
  score: number;
  results: RequirementResult[];
  confirmed: ConfirmedSkill[];
}

export interface MatchStore {
  // Creates the match and its first version together; nothing is left behind if either fails.
  createMatch(match: NewMatch, first: NewVersion): Promise<string>;
  getMatch(matchId: string): Promise<StoredMatch>;
  listMatches(): Promise<MatchSummary[]>;
  // Throws VersionConflictError when that version number is already taken.
  addVersion(matchId: string, version: NewVersion): Promise<void>;
}

const failed = (what: string, error: { code?: string } | null) => new Error(`Could not ${what} (${error?.code ?? "unknown"})`);

interface VersionRow {
  version: number;
  resume_text: string;
  score: number;
  results: RequirementResult[];
  confirmed: ConfirmedSkill[];
  created_at: string;
}

export function createSupabaseMatchStore(client: SupabaseClient, userId: string): MatchStore {
  return {
    async createMatch(match, first) {
      const { data, error } = await client
        .from("resume_matches")
        .insert({
          user_id: userId,
          title: match.title,
          job_url: match.jobUrl,
          job_text: match.jobText,
          requirements: match.requirements,
          target_score: match.targetScore,
        })
        .select("id")
        .single();
      if (error || !data) throw failed("save the match", error);
      const matchId = data.id as string;

      const { error: versionError } = await client.from("resume_versions").insert({
        match_id: matchId,
        user_id: userId,
        version: first.version,
        resume_text: first.resumeText,
        score: first.score,
        results: first.results,
        confirmed: first.confirmed,
      });
      if (versionError) {
        // Two inserts are not one transaction, so undo the first by hand.
        await client.from("resume_matches").delete().eq("id", matchId);
        throw failed("save the resume version", versionError);
      }
      return matchId;
    },

    async addVersion(matchId, version) {
      const { error } = await client.from("resume_versions").insert({
        match_id: matchId,
        user_id: userId,
        version: version.version,
        resume_text: version.resumeText,
        score: version.score,
        results: version.results,
        confirmed: version.confirmed,
      });
      // 23505 = unique violation: (match, version) was saved by another request first.
      if (error?.code === "23505") throw new VersionConflictError();
      if (error) throw failed("save the resume version", error);
    },

    async getMatch(matchId) {
      const { data, error } = await client
        .from("resume_matches")
        .select("id, title, job_url, job_text, requirements, target_score, created_at, resume_versions(version, resume_text, score, results, confirmed, created_at)")
        .eq("id", matchId)
        .maybeSingle();
      if (error) throw failed("read the match", error);
      if (!data) throw new MatchNotFoundError();
      const versions = ((data.resume_versions ?? []) as VersionRow[])
        .map((v) => ({ version: v.version, resumeText: v.resume_text, score: v.score, results: v.results, confirmed: v.confirmed, createdAt: v.created_at }))
        .sort((a, b) => a.version - b.version);
      return {
        id: data.id as string,
        title: data.title as string,
        jobUrl: (data.job_url as string | null) ?? null,
        jobText: data.job_text as string,
        requirements: data.requirements as Requirement[],
        targetScore: data.target_score as number,
        createdAt: data.created_at as string,
        versions,
      };
    },

    async listMatches() {
      const { data, error } = await client
        .from("resume_matches")
        .select("id, title, job_url, created_at, resume_versions(version, score)")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw failed("read the matches", error);
      return (data ?? []).map((row) => {
        const versions = ((row.resume_versions ?? []) as { version: number; score: number }[]).sort((a, b) => b.version - a.version);
        return {
          id: row.id as string,
          title: row.title as string,
          jobUrl: (row.job_url as string | null) ?? null,
          createdAt: row.created_at as string,
          latestVersion: versions[0]?.version ?? 0,
          latestScore: versions[0]?.score ?? null,
        };
      });
    },
  };
}
