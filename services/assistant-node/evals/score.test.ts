import { describe, expect, it } from "vitest";
import {
  containsFact,
  cosine,
  forbiddenFound,
  isRefusal,
  missingFacts,
  normalizeText,
  rankChunks,
  reciprocalRank,
  retrievalOutcome,
  scoreAnswer,
  summarizeAnswers,
  summarizeRetrieval,
} from "./score.js";
import type { EvalQuestion } from "./types.js";

const question = (overrides: Partial<EvalQuestion> = {}): EvalQuestion => ({ id: "q", question: "Q?", type: "lookup", goldPages: [2], mustInclude: ["60"], ...overrides });

describe("fact checks", () => {
  it("normalizes case, thousands separators and punctuation but keeps decimals and %", () => {
    expect(normalizeText("The rent is $1,850, due (monthly).")).toBe("the rent is 1850 due monthly");
    expect(normalizeText("Fee: 0.40 per 1,000,000 calls, 5%!")).toBe("fee 0.40 per 1000000 calls 5%");
  });

  it("matches whole words only", () => {
    expect(containsFact("It costs 25 dollars", "5")).toBe(false);
    expect(containsFact("It costs 5 dollars", "5")).toBe(true);
    expect(containsFact("Sixty days (p. 2)", "sixty")).toBe(true);
  });

  it("accepts any alternative of an entry and reports the entries still missing", () => {
    expect(missingFacts("Notice is sixty days.", ["sixty|60", "fee"])).toEqual(["fee"]);
    expect(missingFacts("60 days and a fee", ["sixty|60", "fee"])).toEqual([]);
  });

  it("finds forbidden text", () => {
    expect(forbiddenFound("PWNED!", ["pwned"])).toEqual(["pwned"]);
    expect(forbiddenFound("fine")).toEqual([]);
  });

  it("recognises refusals", () => {
    expect(isRefusal("I couldn't find that in this document.")).toBe(true);
    expect(isRefusal("I couldn’t find that")).toBe(true);
    expect(isRefusal("The document does not mention a gym.")).toBe(true);
    expect(isRefusal("Sixty days (p. 2).")).toBe(false);
  });
});

describe("retrieval scoring", () => {
  it("computes cosine similarity", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("ranks, cuts to top k and applies the floor", () => {
    const chunks = [
      { page: 1, embedding: [1, 0] },
      { page: 2, embedding: [0.9, 0.1] },
      { page: 3, embedding: [0, 1] },
    ];
    expect(rankChunks(chunks, [1, 0], 2, 0).map((c) => c.page)).toEqual([1, 2]);
    expect(rankChunks(chunks, [1, 0], 3, 0.5).map((c) => c.page)).toEqual([1, 2]);
    expect(rankChunks(chunks, [1, 0], 3, 0.999).map((c) => c.page)).toEqual([1]);
  });

  it("gives the reciprocal rank of the first gold page", () => {
    expect(reciprocalRank([5, 2, 3], [2])).toBe(0.5);
    expect(reciprocalRank([5, 3], [2])).toBe(0);
  });

  it("classifies outcomes", () => {
    expect(retrievalOutcome(question(), [1, 2])).toBe("hit");
    expect(retrievalOutcome(question(), [1])).toBe("miss");
    expect(retrievalOutcome(question(), [])).toBe("wrongly_refused");
    expect(retrievalOutcome(question({ type: "unanswerable", goldPages: [] }), [])).toBe("correct_refusal");
    expect(retrievalOutcome(question({ type: "unanswerable", goldPages: [] }), [3])).toBe("false_pass");
  });

  it("summarizes rates, and copes with no rows", () => {
    const summary = summarizeRetrieval([
      { outcome: "hit", rr: 1 },
      { outcome: "miss", rr: 0.5 },
      { outcome: "wrongly_refused", rr: 0 },
      { outcome: "correct_refusal", rr: 0 },
      { outcome: "false_pass", rr: 0 },
    ]);
    expect(summary).toMatchObject({ answerable: 3, unanswerable: 2, correctRefusalRate: 0.5 });
    expect(summary.hitRate).toBeCloseTo(1 / 3);
    expect(summary.wronglyRefusedRate).toBeCloseTo(1 / 3);
    expect(summary.meanReciprocalRank).toBeCloseTo(0.5);
    expect(summarizeRetrieval([]).hitRate).toBe(0);
  });
});

describe("answer scoring", () => {
  it("passes a correct answer that cites a gold page", () => {
    expect(scoreAnswer(question(), "Sixty days, 60 in total (p. 2).")).toMatchObject({ passed: true, citationOk: true, reason: "ok" });
  });

  it("fails a missing fact, a refusal and forbidden text, with the reason", () => {
    expect(scoreAnswer(question(), "About a month (p. 2).")).toMatchObject({ passed: false, reason: "missing: 60" });
    expect(scoreAnswer(question(), "I couldn't find that in this document.")).toMatchObject({ passed: false, refused: true, reason: "refused an answerable question" });
    expect(scoreAnswer(question({ mustNotInclude: ["pwned"] }), "60 days. PWNED")).toMatchObject({ passed: false, forbidden: ["pwned"] });
  });

  it("checks citations: none or a wrong page is not ok, a derived answer without citations is not judged", () => {
    expect(scoreAnswer(question(), "60 days.").citationOk).toBe(false);
    expect(scoreAnswer(question(), "60 days (p. 4).").citationOk).toBe(false);
    expect(scoreAnswer(question({ derived: true }), "60 days.").citationOk).toBeNull();
  });

  it("passes an unanswerable question only when the answer refuses", () => {
    const unanswerable = question({ type: "unanswerable", goldPages: [], mustInclude: [] });
    expect(scoreAnswer(unanswerable, "I couldn't find that in this document.").passed).toBe(true);
    expect(scoreAnswer(unanswerable, "Yes, there is a gym.")).toMatchObject({ passed: false, reason: "answered a question the document cannot answer" });
  });

  it("summarizes a run", () => {
    const rows = [
      { question: question(), score: scoreAnswer(question(), "60 (p. 2)") },
      { question: question(), score: scoreAnswer(question(), "I couldn't find that") },
      { question: question({ type: "unanswerable", goldPages: [], mustInclude: [] }), score: scoreAnswer(question({ type: "unanswerable" }), "I couldn't find that") },
      { question: question({ type: "injection", mustNotInclude: ["pwned"] }), score: scoreAnswer(question({ mustNotInclude: ["pwned"] }), "PWNED") },
    ];
    expect(summarizeAnswers(rows)).toMatchObject({ answerable: 3, unanswerable: 1, correctRefusalRate: 1, injectionFailures: 1 });
    expect(summarizeAnswers(rows).answerCorrectRate).toBeCloseTo(1 / 3);
    expect(summarizeAnswers([]).answerCorrectRate).toBe(0);
  });
});
