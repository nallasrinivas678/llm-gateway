// Runs the agent evals against the REAL model. From services/assistant-node:
//   npm run eval:agent                          every model scenario
//   npm run eval:agent -- --only m-add-task     one scenario, or an area (write, read, injection ...)
//   npm run eval:agent -- --max-calls 20        stop before a scenario would pass this many model calls
//   npm run eval:agent -- --list                list the scenarios and exit
// Each scenario costs a few model calls (every tool round is one), so a full run needs billing on the
// key; on the free tier use --only or --max-calls and run a part a day. The harness tier (a scripted
// model) runs with `npm test` and needs none of this. Reads GOOGLE_API_KEY from the environment
// (npm run eval:agent loads .env). Never prints it.
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSettings } from "../../src/config.js";
import { isQuotaError } from "../../src/resumeMatch/generate.js";
import { modelScenarios } from "./modelScenarios.js";
import { runScenario } from "./runner.js";
import { scoreScenario, summarize, type ScenarioResult } from "./score.js";
import type { Scenario } from "./types.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const only = flag("only");
const chosen = modelScenarios.filter((s) => !only || s.id === only || s.area === only);
if (chosen.length === 0) throw new Error(`No scenario or area called ${only}.`);

if (args.includes("--list")) {
  for (const s of chosen) console.log(`${s.id.padEnd(34)} ${s.area.padEnd(13)} ${s.description}`);
  process.exit(0);
}

const settings = loadSettings().chat;
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (put it in .env).");
const model = new ChatGoogleGenerativeAI({ apiKey, model: settings.model, temperature: settings.temperature });

const maxCalls = Number(flag("max-calls") ?? Infinity);
// A scenario makes about two model calls plus one per tool round; this is a rough guess for the budget.
const roughCalls = (s: Scenario) => 2 + s.steps.filter((step) => typeof step === "string").length;

const results: (ScenarioResult & { modelCalls: number; seconds: number })[] = [];
const notRun: string[] = [];
let calls = 0;
let stoppedBy = "";

for (const scenario of chosen) {
  if (stoppedBy || calls + roughCalls(scenario) > maxCalls) {
    notRun.push(scenario.id);
    stoppedBy ||= `--max-calls ${maxCalls}`;
    continue;
  }
  const started = performance.now();
  try {
    const trace = await runScenario(scenario, model);
    calls += trace.modelCalls;
    const result = scoreScenario(scenario, trace);
    results.push({ ...result, modelCalls: trace.modelCalls, seconds: (performance.now() - started) / 1000 });
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${scenario.id.padEnd(34)} ${trace.modelCalls} calls  ${((performance.now() - started) / 1000).toFixed(1)}s`);
    for (const failure of result.failures) console.log(`      - ${failure}`);
    // Spaced out so a run stays under the per-minute limit.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    if (!isQuotaError(error)) throw error;
    stoppedBy = "the model's usage limit (quota)";
    notRun.push(scenario.id);
  }
}

const summary = summarize(results);
console.log(`\n${summary.passed}/${summary.total} scenarios passed, ${calls} model calls.`);
for (const [area, s] of Object.entries(summary.byArea)) console.log(`  ${area.padEnd(14)} ${s.passed}/${s.total}`);
if (notRun.length > 0) console.log(`\nNot run (stopped by ${stoppedBy}): ${notRun.join(", ")}`);

const dir = fileURLToPath(new URL("../results/", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}agent-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
// Results hold scenario ids, pass/fail and the failure reasons: no secrets, no user data (it is all made up).
writeFileSync(file, JSON.stringify({ model: settings.model, summary, results, notRun }, null, 2));
console.log(`Saved ${file.replace(/^.*[\\/]evals[\\/]/, "evals/")}`);
