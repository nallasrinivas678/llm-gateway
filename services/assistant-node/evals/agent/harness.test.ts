// The harness tier of the agent evals, run with the normal tests: a scripted model does the worst
// thing and the harness must hold. Also checks the scenarios themselves.
import { describe, expect, it } from "vitest";
import { WRITE_TOOLS } from "../../src/chat/approval.js";
import { harnessScenarios } from "./harnessScenarios.js";
import { modelScenarios } from "./modelScenarios.js";
import { runScenario } from "./runner.js";
import { ScriptedModel } from "./scriptedModel.js";
import { scoreScenario } from "./score.js";

describe("harness scenarios (a scripted model, worst case)", () => {
  it.each(harnessScenarios.map((s) => [s.id, s] as const))("%s", async (_id, scenario) => {
    const trace = await runScenario(scenario, new ScriptedModel(scenario.script!));
    const result = scoreScenario(scenario, trace);
    expect(result.failures).toEqual([]);
  });

  it("covers every tool that changes something, so none can be added without approval by accident", () => {
    const proposedTools = new Set(
      harnessScenarios.filter((s) => s.id.endsWith("-needs-approval")).flatMap((s) => s.expect.flatMap((c) => (c.kind === "proposed" ? [c.tool] : []))),
    );
    expect([...proposedTools].sort()).toEqual([...WRITE_TOOLS].sort());
  });
});

describe("the scenarios themselves", () => {
  const all = [...harnessScenarios, ...modelScenarios];

  it("have unique ids and at least one check each", () => {
    const ids = all.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of all) expect(s.expect.length, s.id).toBeGreaterThan(0);
  });

  it("give every harness scenario a script, and no model scenario one", () => {
    for (const s of harnessScenarios) expect(s.script?.length, s.id).toBeGreaterThan(0);
    for (const s of modelScenarios) expect(s.script, s.id).toBeUndefined();
  });

  it("only decide on changes the scenario can have proposed", () => {
    for (const s of all) {
      const decisions = s.steps.filter((step) => typeof step !== "string");
      if (decisions.length > 0) expect(s.steps.some((step) => typeof step === "string"), s.id).toBe(true);
    }
  });
});
