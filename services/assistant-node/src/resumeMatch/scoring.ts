// The score is worked out here, in code, not by the model. The model only says, per requirement,
// whether the resume meets it and which resume line shows it; this file checks that the line is
// really in the resume and turns the answers into a number. That keeps the score stable between
// runs and explainable to the user.

export type RequirementKind = "must" | "nice";
export type RequirementStatus = "met" | "partial" | "missing";

export interface Requirement {
  id: number;
  text: string;
  kind: RequirementKind;
}

export interface RequirementResult {
  requirementId: number;
  status: RequirementStatus;
  // A line copied from the resume that shows the requirement; empty when missing.
  evidence: string;
}

const WEIGHT: Record<RequirementKind, number> = { must: 2, nice: 1 };
const CREDIT: Record<RequirementStatus, number> = { met: 1, partial: 0.5, missing: 0 };

// Lower case, one kind of quote and dash, single spaces: so a quote still matches when the model
// changes "-" into "–" or drops a line break.
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛`]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[•▪●◦·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// One result per requirement, in requirement order. A claim whose quote is not found in the resume
// becomes "missing": the model is not allowed to imagine a skill.
export function verifyResults(requirements: Requirement[], resumeText: string, raw: RequirementResult[]): RequirementResult[] {
  const resume = normalizeForMatch(resumeText);
  return requirements.map((requirement) => {
    const answer = raw.find((r) => r.requirementId === requirement.id);
    const evidence = (answer?.evidence ?? "").trim();
    if (!answer || answer.status === "missing" || evidence.length === 0 || !resume.includes(normalizeForMatch(evidence))) {
      return { requirementId: requirement.id, status: "missing", evidence: "" };
    }
    return { requirementId: requirement.id, status: answer.status, evidence };
  });
}

// A new version only adds lines, so a requirement that was met before should not slip because the
// model judged it differently this time. Per requirement, keep the better of the earlier result and
// the new one; an earlier result counts only if its quote is still in the text (the user may have
// edited lines away).
export function keepBest(
  requirements: Requirement[],
  resumeText: string,
  previous: RequirementResult[],
  current: RequirementResult[],
): RequirementResult[] {
  const stillValid = verifyResults(requirements, resumeText, previous);
  return requirements.map((requirement) => {
    const before = stillValid.find((r) => r.requirementId === requirement.id);
    const now = current.find((r) => r.requirementId === requirement.id);
    if (!now) return before ?? { requirementId: requirement.id, status: "missing", evidence: "" };
    return before && CREDIT[before.status] > CREDIT[now.status] ? before : now;
  });
}

// Must-haves count twice as much as nice-to-haves; partial earns half. 0 to 100, rounded.
export function computeScore(requirements: Requirement[], results: RequirementResult[]): number {
  let earned = 0;
  let possible = 0;
  for (const requirement of requirements) {
    const result = results.find((r) => r.requirementId === requirement.id);
    possible += WEIGHT[requirement.kind];
    earned += WEIGHT[requirement.kind] * CREDIT[result?.status ?? "missing"];
  }
  return possible === 0 ? 0 : Math.round((earned / possible) * 100);
}

// The requirements the user can act on: everything not fully met.
export function openGaps(requirements: Requirement[], results: RequirementResult[]): Requirement[] {
  return requirements.filter((requirement) => results.find((r) => r.requirementId === requirement.id)?.status !== "met");
}
