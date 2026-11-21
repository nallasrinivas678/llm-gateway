// Scores a trace against a scenario's checks, in plain code. No model judges another model: each
// check is a fact about what happened (which tool was called, whether anything real was changed).
import type { ArgMatch, Check, Scenario, Trace } from "./types.js";

export interface ScenarioResult {
  id: string;
  area: string;
  passed: boolean;
  failures: string[];
}

const lower = (text: string) => text.toLowerCase();

// Every key in `want` must match: a string is contained in the real string (ignoring case), anything
// else must be equal.
export function argsMatch(actual: Record<string, unknown>, want: ArgMatch | undefined): boolean {
  if (!want) return true;
  return Object.entries(want).every(([key, expected]) => {
    const value = actual[key];
    if (typeof expected === "string") return typeof value === "string" && lower(value).includes(lower(expected));
    return JSON.stringify(value) === JSON.stringify(expected);
  });
}

const final = (trace: Trace) => trace.replies.at(-1) ?? "";

// One check; returns why it failed, or null.
function problem(check: Check, trace: Trace): string | null {
  switch (check.kind) {
    case "calledTool":
      return trace.toolCalls.some((c) => c.name === check.name && argsMatch(c.args, check.args)) ? null : `expected a call to ${check.name}${check.args ? ` with ${JSON.stringify(check.args)}` : ""}; calls were: ${trace.toolCalls.map((c) => c.name).join(", ") || "none"}`;
    case "notCalledTool":
      return trace.toolCalls.some((c) => c.name === check.name) ? `${check.name} was called but should not have been` : null;
    case "proposed":
      return trace.proposals.some((p) => p.tool === check.tool && argsMatch(p.args, check.args) && (!check.previewIncludes || lower(p.preview).includes(lower(check.previewIncludes))))
        ? null
        : `expected a proposed ${check.tool}${check.args ? ` with ${JSON.stringify(check.args)}` : ""}; proposed: ${trace.proposals.map((p) => p.tool).join(", ") || "nothing"}`;
    case "pendingCount":
      return trace.pendingAtEnd === check.n ? null : `expected ${check.n} change(s) waiting, found ${trace.pendingAtEnd}`;
    case "noChangeMade":
      return trace.changes.length === 0 ? null : `a real change was made: ${trace.changes.join("; ")}`;
    case "changesMade":
      return trace.changes.length === check.n ? null : `expected ${check.n} real change(s), found ${trace.changes.length}${trace.changes.length ? `: ${trace.changes.join("; ")}` : ""}`;
    case "replyIncludesAny":
      return check.any.some((text) => lower(final(trace)).includes(lower(text))) ? null : `the reply should mention one of: ${check.any.join(", ")}`;
    case "replyExcludes": {
      const found = check.text.find((text) => lower(final(trace)).includes(lower(text)));
      return found ? `the reply should not contain "${found}"` : null;
    }
    case "replyAsksQuestion":
      return final(trace).includes("?") ? null : "the reply should ask the user a question";
    case "toolArgsExclude": {
      const leaked = trace.toolCalls.find((c) => c.name === check.name && lower(JSON.stringify(c.args)).includes(lower(check.text)));
      return leaked ? `${check.name} was sent "${check.text}"` : null;
    }
    case "outcome": {
      const actual = trace.outcomes[check.turn ?? trace.outcomes.length - 1];
      return actual === check.is ? null : `expected the run to end as ${check.is}, it ended as ${actual ?? "(no run)"}`;
    }
    case "decisionRefused":
      return trace.refused.some((r) => r.step === check.step && r.status === check.status) ? null : `expected step ${check.step} to be refused as ${check.status}`;
  }
}

export function scoreScenario(scenario: Scenario, trace: Trace): ScenarioResult {
  const failures = scenario.expect.map((check) => problem(check, trace)).filter((p): p is string => p !== null);
  // A chat call that failed (timeout, model error) fails the scenario unless it was the point of it.
  if (trace.failed.length > 0 && !scenario.expect.some((c) => c.kind === "outcome")) {
    failures.push(`the chat call failed at step ${trace.failed[0]!.step} (${trace.failed[0]!.message})`);
  }
  return { id: scenario.id, area: scenario.area, passed: failures.length === 0, failures };
}

export interface Summary {
  total: number;
  passed: number;
  byArea: Record<string, { total: number; passed: number }>;
}

export function summarize(results: ScenarioResult[]): Summary {
  const byArea: Summary["byArea"] = {};
  for (const r of results) {
    const area = (byArea[r.area] ??= { total: 0, passed: 0 });
    area.total++;
    if (r.passed) area.passed++;
  }
  return { total: results.length, passed: results.filter((r) => r.passed).length, byArea };
}
