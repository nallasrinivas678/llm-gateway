// HTTP routes for PDF Q&A, mounted at /assistant/docs (behind the same login check as the other
// /assistant routes). Same paths, request bodies and status codes as the .NET service.
import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth.js";
import { createRateLimiter, isQuotaError } from "../resumeMatch/generate.js";
import type { AskService } from "./ask.js";
import { DocBusyError, DocNotFoundError, DocNotReadyError } from "./errors.js";
import type { IngestService } from "./ingest.js";

export interface DocServices {
  ingest: IngestService;
  ask: AskService;
}

export function createDocRoutes(services: DocServices | undefined, options: { maxQuestionChars: number; questionsPerMinute: number }) {
  const allow = createRateLimiter(options.questionsPerMinute);
  const routes = new Hono<AuthEnv>();
  const notConfigured = { detail: "PDF Q&A is not configured on this server." };
  const logFailure = (what: string, error: unknown) =>
    // Log what failed, never the question or the document text.
    console.error(`${what} failed:`, error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error");

  const ingestBody = z.object({ documentId: z.string().uuid() });

  // Starts ingest and returns 202 right away; the web app watches documents.status
  // (processing -> ready | failed). Calling it again re-runs ingest.
  routes.post("/", async (c) => {
    if (!services) return c.json(notConfigured, 503);
    const parsed = ingestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: "documentId is required." }, 400);
    try {
      await services.ingest.start(c.get("userId"), c.get("jwt"), parsed.data.documentId);
      return c.body(null, 202);
    } catch (error) {
      if (error instanceof DocNotFoundError) return c.body(null, 404);
      if (error instanceof DocBusyError) return c.json({ detail: error.message }, 409);
      logFailure("pdf ingest start", error);
      return c.json({ detail: "Couldn't start processing the document. Try again." }, 502);
    }
  });

  const askBody = z.object({ documentId: z.string().uuid(), question: z.string().optional() });

  // Single JSON response: { answer, sources: [{ page, snippet }] }. Rate limited per user.
  routes.post("/ask", async (c) => {
    if (!services) return c.json(notConfigured, 503);
    const parsed = askBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: "documentId is required." }, 400);
    const question = parsed.data.question?.trim();
    if (!question || question.length > options.maxQuestionChars) {
      return c.json({ detail: `question is required and must be at most ${options.maxQuestionChars} characters.` }, 400);
    }
    if (!allow(c.get("userId"))) return c.json({ detail: "Too many requests. Wait a minute and try again." }, 429);

    try {
      return c.json(await services.ask.ask(c.get("userId"), c.get("jwt"), parsed.data.documentId, question));
    } catch (error) {
      if (error instanceof DocNotFoundError) return c.body(null, 404);
      if (error instanceof DocNotReadyError) return c.json({ detail: error.message }, 409);
      if (isQuotaError(error)) return c.json({ detail: "The AI model's usage limit is reached. Try again later." }, 503);
      logFailure("pdf ask", error);
      return c.json({ detail: "The answer service is unavailable. Try again shortly." }, 502);
    }
  });

  return routes;
}
