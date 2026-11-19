import { describe, expect, it } from "vitest";
import { computeScore, normalizeForMatch, openGaps, verifyResults, type Requirement, type RequirementResult } from "./scoring.js";

const requirements: Requirement[] = [
  { id: 1, text: "5+ years C#", kind: "must" },
  { id: 2, text: "Azure", kind: "must" },
  { id: 3, text: "Docker and Kubernetes", kind: "must" },
  { id: 4, text: "React", kind: "nice" },
];

const resume = "Jane Doe\n7 years building C# services at Fabrikam\nPackaged services with Docker – shipped weekly";

describe("verifyResults", () => {
  it("keeps claims whose quote is really in the resume, ignoring case, spacing, quotes and dashes", () => {
    const raw: RequirementResult[] = [
      { requirementId: 1, status: "met", evidence: "7 YEARS building  C# services" },
      { requirementId: 3, status: "partial", evidence: "Packaged services with Docker - shipped weekly" },
    ];
    expect(verifyResults(requirements, resume, raw)).toEqual([
      { requirementId: 1, status: "met", evidence: "7 YEARS building  C# services" },
      { requirementId: 2, status: "missing", evidence: "" },
      { requirementId: 3, status: "partial", evidence: "Packaged services with Docker - shipped weekly" },
      { requirementId: 4, status: "missing", evidence: "" },
    ]);
  });

  it("turns a claim with an invented or empty quote into missing", () => {
    const raw: RequirementResult[] = [
      { requirementId: 2, status: "met", evidence: "Deployed to Azure App Service" },
      { requirementId: 4, status: "partial", evidence: "  " },
    ];
    const results = verifyResults(requirements, resume, raw);
    expect(results.find((r) => r.requirementId === 2)).toEqual({ requirementId: 2, status: "missing", evidence: "" });
    expect(results.find((r) => r.requirementId === 4)?.status).toBe("missing");
  });

  it("drops results for ids that are not requirements", () => {
    const results = verifyResults(requirements, resume, [{ requirementId: 99, status: "met", evidence: "Jane Doe" }]);
    expect(results.map((r) => r.requirementId)).toEqual([1, 2, 3, 4]);
  });
});

describe("computeScore", () => {
  it("weighs must twice as much as nice, and partial as half", () => {
    const results: RequirementResult[] = [
      { requirementId: 1, status: "met", evidence: "x" },        // 2 of 2
      { requirementId: 2, status: "missing", evidence: "" },     // 0 of 2
      { requirementId: 3, status: "partial", evidence: "x" },    // 1 of 2
      { requirementId: 4, status: "met", evidence: "x" },        // 1 of 1
    ];
    expect(computeScore(requirements, results)).toBe(57);        // 4 of 7
  });

  it("counts a requirement without a result as missing, and an empty list as 0", () => {
    expect(computeScore(requirements, [])).toBe(0);
    expect(computeScore([], [])).toBe(0);
  });
});

describe("openGaps", () => {
  it("lists every requirement that is not fully met", () => {
    const results: RequirementResult[] = [
      { requirementId: 1, status: "met", evidence: "x" },
      { requirementId: 3, status: "partial", evidence: "x" },
    ];
    expect(openGaps(requirements, results).map((r) => r.id)).toEqual([2, 3, 4]);
  });
});

describe("normalizeForMatch", () => {
  it("unifies quotes, dashes, bullets and spaces", () => {
    expect(normalizeForMatch("• Led ‘Project X’ — “fast”\n  delivery")).toBe(`led 'project x' - "fast" delivery`);
  });
});
