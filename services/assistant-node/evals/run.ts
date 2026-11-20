// Runs the PDF Q&A evals. From services/assistant-node:
//   npm run eval -- retrieval            sweep chunk size, top-k and similarity floor (embeddings only)
//   npm run eval -- answer               ask the questions with the model (uses the daily model quota)
// Options: --only <dataset>  --chunk <n>  --topk <n>  --floor <n>  --max-calls <n> (answer mode)
// Reads GOOGLE_API_KEY from the environment (npm run eval loads .env). Never prints it.
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildUserMessage, createAnswer, filterRelevant, NOT_FOUND_ANSWER, SYSTEM_PROMPT, sourcesUsed } from "../src/docQa/ask.js";
import { chunkPage } from "../src/docQa/chunker.js";
import { createEmbedder } from "../src/docQa/embeddings.js";
import { extractPages } from "../src/docQa/pages.js";
import { loadSettings } from "../src/config.js";
import { isQuotaError } from "../src/resumeMatch/generate.js";
import { makePdf } from "../src/resumeMatch/pdf.testutil.js";
import { withDiskCache } from "./cache.js";
import { datasets } from "./datasets/index.js";
import { rankChunks, reciprocalRank, retrievalOutcome, scoreAnswer, summarizeAnswers, summarizeRetrieval, type AnswerScore, cosine } from "./score.js";
import type { EvalDataset, EvalQuestion } from "./types.js";

const args = process.argv.slice(2);
const mode = args[0] === "answer" ? "answer" : "retrieval";
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const settings = loadSettings().docQa;
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error("GOOGLE_API_KEY is not set (put it in .env).");

const embed = withDiskCache(
  createEmbedder({ apiKey, model: settings.embeddingModel, dimensions: settings.embeddingDimensions, timeoutSeconds: settings.embeddingTimeoutSeconds }),
  new URL("./.cache/embeddings.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  `${settings.embeddingModel}/${settings.embeddingDimensions}`,
);

const chosen = datasets.filter((d) => !flag("only") || d.name === flag("only"));
if (chosen.length === 0) throw new Error(`No dataset called ${flag("only")}.`);

const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(4);

// The pages as the real ingest reads them: through a real PDF.
async function pagesOf(dataset: EvalDataset) {
  return extractPages(makePdf(dataset.pages), { maxPages: 200, maxPdfBytes: 20 * 1024 * 1024, minTextChars: 1 });
}

async function embeddedChunks(dataset: EvalDataset, chunkChars: number) {
  const overlap = Math.round(chunkChars / 8);
  const chunks = (await pagesOf(dataset)).flatMap((p) => chunkPage(p.page, p.text, chunkChars, overlap));
  const vectors = await embed(chunks.map((c) => c.content), "RETRIEVAL_DOCUMENT");
  return chunks.map((c, i) => ({ ...c, embedding: vectors[i]! }));
}

async function retrievalSweep() {
  const sizes = flag("chunk") ? [Number(flag("chunk"))] : [600, 1200, 2400];
  const topKs = flag("topk") ? [Number(flag("topk"))] : [4, 6, 8];
  const floors = flag("floor") ? [Number(flag("floor"))] : [0.4, 0.45, 0.5, 0.55, 0.6, 0.65];

  const queryVectors = new Map<string, number[]>();
  const allQuestions = chosen.flatMap((d) => d.questions);
  const vectors = await embed(allQuestions.map((q) => q.question), "RETRIEVAL_QUERY");
  allQuestions.forEach((q, i) => queryVectors.set(q.id, vectors[i]!));

  const rows: { chunkChars: number; topK: number; floor: number; balanced: number; hit: number; mrr: number; refusal: number; wronglyRefused: number }[] = [];
  for (const chunkChars of sizes) {
    const corpora = await Promise.all(chosen.map(async (d) => ({ dataset: d, chunks: await embeddedChunks(d, chunkChars) })));
    for (const topK of topKs) {
      for (const floor of floors) {
        const scored = corpora.flatMap(({ dataset, chunks }) =>
          dataset.questions.map((question) => {
            const query = queryVectors.get(question.id)!;
            const retrieved = rankChunks(chunks, query, topK, floor).map((c) => c.page);
            // Ranking ignores the floor, so MRR shows how well the right page ranks.
            const ranked = [...chunks].sort((a, b) => cosine(b.embedding, query) - cosine(a.embedding, query)).map((c) => c.page);
            return { outcome: retrievalOutcome(question, retrieved), rr: reciprocalRank(ranked, question.goldPages) };
          }),
        );
        const s = summarizeRetrieval(scored);
        rows.push({ chunkChars, topK, floor, balanced: (s.hitRate + s.correctRefusalRate) / 2, hit: s.hitRate, mrr: s.meanReciprocalRank, refusal: s.correctRefusalRate, wronglyRefused: s.wronglyRefusedRate });
      }
    }
  }

  console.log(`\nRetrieval sweep over ${chosen.map((d) => d.name).join(", ")} (${allQuestions.length} questions)\n`);
  console.log("chunk  topK  floor | hit  MRR   refusal wrongly-refused | balanced");
  for (const r of rows) {
    console.log(`${String(r.chunkChars).padStart(5)}  ${String(r.topK).padStart(4)}  ${r.floor.toFixed(2)}  | ${pct(r.hit)} ${r.mrr.toFixed(2)}  ${pct(r.refusal)}    ${pct(r.wronglyRefused)}           | ${pct(r.balanced)}`);
  }
  const best = [...rows].sort((a, b) => b.balanced - a.balanced || b.floor - a.floor).slice(0, 5);
  console.log("\nBest five (balanced = average of hit rate and correct refusal rate):");
  for (const r of best) console.log(`  chunk ${r.chunkChars}, topK ${r.topK}, floor ${r.floor.toFixed(2)}: ${pct(r.balanced)} (hit ${pct(r.hit)}, refusal ${pct(r.refusal)})`);
  save("retrieval", { rows });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function answerRun() {
  const chunkChars = Number(flag("chunk") ?? settings.chunkChars);
  const topK = Number(flag("topk") ?? settings.topK);
  const floor = Number(flag("floor") ?? settings.minSimilarity);
  const maxCalls = Number(flag("max-calls") ?? 12);
  const model = createAnswer(
    new ChatGoogleGenerativeAI({ apiKey: apiKey!, model: loadSettings().chat.model, temperature: settings.temperature, maxRetries: 0 }),
    { timeoutSeconds: settings.llmTimeoutSeconds, maxRetries: 0 },
  );

  console.log(`\nAnswer eval: chunk ${chunkChars}, topK ${topK}, floor ${floor}, at most ${maxCalls} model calls\n`);
  const done: { question: EvalQuestion; answer: string; score: AnswerScore; seconds: number }[] = [];
  const notRun: string[] = [];
  let calls = 0;
  let stopped = "";

  for (const dataset of chosen) {
    const chunks = await embeddedChunks(dataset, chunkChars);
    const queryVectors = await embed(dataset.questions.map((q) => q.question), "RETRIEVAL_QUERY");
    for (const [i, question] of dataset.questions.entries()) {
      const relevant = filterRelevant(rankChunks(chunks, queryVectors[i]!, topK, 0).map((c) => ({ page: c.page, content: c.content, similarity: c.similarity })), floor);
      let answer = NOT_FOUND_ANSWER;
      const started = Date.now();
      if (relevant.length > 0) {
        if (stopped || calls >= maxCalls) {
          notRun.push(question.id);
          continue;
        }
        if (calls > 0) await sleep(5000);
        try {
          calls++;
          answer = (await model(SYSTEM_PROMPT, buildUserMessage(question.question, relevant))).trim();
        } catch (error) {
          stopped = isQuotaError(error) ? "the model's usage limit was reached" : `a model call failed (${error instanceof Error ? error.message.slice(0, 80) : "unknown"})`;
          notRun.push(question.id);
          continue;
        }
      }
      const score = scoreAnswer(question, answer);
      done.push({ question, answer, score, seconds: (Date.now() - started) / 1000 });
      const cites = sourcesUsed(answer, relevant).map((s) => s.page).join(",");
      console.log(`${score.passed ? "PASS" : "FAIL"} ${question.id.padEnd(12)} ${score.passed ? "" : `${score.reason} | `}pages ${cites || "-"}`);
    }
  }

  const s = summarizeAnswers(done);
  console.log(`\nAnswered ${done.length} questions with ${calls} model calls${notRun.length ? `; not run (${stopped || "call limit"}): ${notRun.join(", ")}` : ""}`);
  console.log(`answer correct ${pct(s.answerCorrectRate)} of ${s.answerable} | correct refusals ${pct(s.correctRefusalRate)} of ${s.unanswerable} | wrongly refused ${pct(s.wronglyRefusedRate)} | citations ok ${pct(s.citationOkRate)} | injection failures ${s.injectionFailures}`);
  save("answer", { settings: { chunkChars, topK, floor }, summary: s, notRun, results: done.map((d) => ({ id: d.question.id, answer: d.answer, ...d.score })) });
}

function save(kind: string, data: unknown) {
  const dir = new URL("./results/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\nSaved ${file}`);
}

await (mode === "answer" ? answerRun() : retrievalSweep());
