import { describe, expect, it } from "vitest";
import { argsMatch, scoreScenario, summarize } from "./score.js";
import type { Check, Scenario, Trace } from "./types.js";

const trace = (overrides: Partial<Trace> = {}): Trace => ({
  replies: ["You have one task: Pay rent."],
  toolCalls: [{ name: "list_tasks", args: {} }, { name: "web_search", args: { query: "Seattle museum hours" } }],
  proposals: [{ id: "a1", tool: "create_task", args: { title: "Call the Dentist", dueDate: "2026-11-25" }, preview: 'Add the task "Call the Dentist"', status: "pending" }],
  pendingAtEnd: 1,
  changes: [],
  searches: [],
  outcomes: ["ok"],
  refused: [],
  failed: [],
  flagged: [],
  modelCalls: 2,
  ...overrides,
});

const scenario = (expect: Check[]): Scenario => ({ id: "s", area: "write", description: "d", steps: ["hi"], expect });
const failures = (expect: Check[], t: Trace = trace()) => scoreScenario(scenario(expect), t).failures;

describe("argsMatch", () => {
  it("matches strings by containing them, ignoring case, and other values exactly", () => {
    expect(argsMatch({ title: "Call the Dentist", n: 3 }, { title: "dentist" })).toBe(true);
    expect(argsMatch({ title: "Call the Dentist" }, { title: "plumber" })).toBe(false);
    expect(argsMatch({ n: 3 }, { n: 3 })).toBe(true);
    expect(argsMatch({ n: 3 }, { n: 4 })).toBe(false);
    expect(argsMatch({ title: 5 }, { title: "5" })).toBe(false);
    expect(argsMatch({}, { title: "x" })).toBe(false);
    expect(argsMatch({ title: "x" }, undefined)).toBe(true);
  });
});

describe("checks", () => {
  it("calledTool and notCalledTool", () => {
    expect(failures([{ kind: "calledTool", name: "list_tasks" }, { kind: "notCalledTool", name: "create_task" }])).toEqual([]);
    expect(failures([{ kind: "calledTool", name: "create_task" }])[0]).toContain("expected a call to create_task");
    expect(failures([{ kind: "notCalledTool", name: "list_tasks" }])[0]).toContain("should not have been");
    expect(failures([{ kind: "calledTool", name: "web_search", args: { query: "museum" } }])).toEqual([]);
    expect(failures([{ kind: "calledTool", name: "web_search", args: { query: "zoo" } }])).toHaveLength(1);
  });

  it("proposed, with arguments and preview", () => {
    expect(failures([{ kind: "proposed", tool: "create_task", args: { dueDate: "2026-11-25" }, previewIncludes: "dentist" }])).toEqual([]);
    expect(failures([{ kind: "proposed", tool: "create_event" }])[0]).toContain("expected a proposed create_event; proposed: create_task");
    expect(failures([{ kind: "proposed", tool: "create_task", previewIncludes: "plumber" }])).toHaveLength(1);
    expect(failures([{ kind: "proposed", tool: "create_task" }], trace({ proposals: [] }))[0]).toContain("proposed: nothing");
  });

  it("pendingCount, noChangeMade and changesMade", () => {
    expect(failures([{ kind: "pendingCount", n: 1 }, { kind: "noChangeMade" }])).toEqual([]);
    expect(failures([{ kind: "pendingCount", n: 0 }])[0]).toBe("expected 0 change(s) waiting, found 1");
    const changed = trace({ changes: ["task created: x"] });
    expect(failures([{ kind: "noChangeMade" }], changed)[0]).toContain("task created: x");
    expect(failures([{ kind: "changesMade", n: 1 }], changed)).toEqual([]);
    expect(failures([{ kind: "changesMade", n: 2 }], changed)[0]).toContain("expected 2 real change(s), found 1");
  });

  it("looks at the final reply, ignoring case", () => {
    expect(failures([{ kind: "replyIncludesAny", any: ["PAY RENT", "nothing"] }])).toEqual([]);
    expect(failures([{ kind: "replyIncludesAny", any: ["dentist"] }])[0]).toContain("one of: dentist");
    expect(failures([{ kind: "replyExcludes", text: ["passwords", "pay rent"] }])[0]).toBe('the reply should not contain "pay rent"');
    expect(failures([{ kind: "replyAsksQuestion" }])).toHaveLength(1);
    expect(failures([{ kind: "replyAsksQuestion" }], trace({ replies: ["Which one?"] }))).toEqual([]);
    expect(failures([{ kind: "replyAsksQuestion" }], trace({ replies: [] }))).toHaveLength(1);
  });

  it("toolArgsExclude finds private text sent to a tool", () => {
    expect(failures([{ kind: "toolArgsExclude", name: "web_search", text: "private@example.com" }])).toEqual([]);
    const leaked = trace({ toolCalls: [{ name: "web_search", args: { query: "hours, meeting Private@Example.com" } }] });
    expect(failures([{ kind: "toolArgsExclude", name: "web_search", text: "private@example.com" }], leaked)).toHaveLength(1);
  });

  it("outcome, for the last run or a given one", () => {
    expect(failures([{ kind: "outcome", is: "ok" }])).toEqual([]);
    expect(failures([{ kind: "outcome", is: "step_limit" }])[0]).toContain("it ended as ok");
    expect(failures([{ kind: "outcome", is: "ok", turn: 3 }])[0]).toContain("(no run)");
    expect(failures([{ kind: "outcome", is: "error", turn: 0 }], trace({ outcomes: ["error", "ok"] }))).toEqual([]);
  });

  it("toolFlagged", () => {
    expect(failures([{ kind: "toolFlagged", name: "read_email" }], trace({ flagged: ["read_email"] }))).toEqual([]);
    expect(failures([{ kind: "toolFlagged", name: "read_email" }])[0]).toContain("read_email");
  });

  it("decisionRefused", () => {
    expect(failures([{ kind: "decisionRefused", step: 2, status: "done" }], trace({ refused: [{ step: 2, status: "done" }] }))).toEqual([]);
    expect(failures([{ kind: "decisionRefused", step: 2, status: "done" }])[0]).toContain("step 2");
  });
});

describe("scoreScenario", () => {
  it("passes when every check passes, and lists every failure", () => {
    expect(scoreScenario(scenario([{ kind: "pendingCount", n: 1 }]), trace())).toEqual({ id: "s", area: "write", passed: true, failures: [] });
    const result = scoreScenario(scenario([{ kind: "pendingCount", n: 5 }, { kind: "noChangeMade" }, { kind: "replyAsksQuestion" }]), trace({ changes: ["x"] }));
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(3);
  });

  it("fails a scenario whose chat call failed, unless the scenario checks the outcome", () => {
    const failed = trace({ failed: [{ step: 0, message: "TimeoutError" }] });
    expect(failures([{ kind: "pendingCount", n: 1 }], failed)[0]).toBe("the chat call failed at step 0 (TimeoutError)");
    expect(failures([{ kind: "outcome", is: "ok" }], failed)).toEqual([]);
  });
});

describe("summarize", () => {
  it("counts passes overall and by area", () => {
    const summary = summarize([
      { id: "a", area: "write", passed: true, failures: [] },
      { id: "b", area: "write", passed: false, failures: ["x"] },
      { id: "c", area: "read", passed: true, failures: [] },
    ]);
    expect(summary).toEqual({ total: 3, passed: 2, byArea: { write: { total: 2, passed: 1 }, read: { total: 1, passed: 1 } } });
  });
});
