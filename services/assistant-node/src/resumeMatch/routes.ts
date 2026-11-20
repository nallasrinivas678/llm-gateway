// HTTP routes for resume match, mounted at /resume. Thin: validate input, call the service,
// translate errors into status codes. Errors carry a `detail` the web app can show.
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createAuth, type AuthEnv } from "../auth.js";
import type { Config } from "../config.js";
import { JobPageError, MatchNotFoundError, ResumeInputError, VersionConflictError } from "./errors.js";
import { createRateLimiter, isQuotaError } from "./generate.js";
import { fetchJobText } from "./jobPage.js";
import type { MatchService } from "./matchService.js";
import { viewOf } from "./matchService.js";
import { extractPdfText } from "./pdfText.js";
import { placeBullet } from "./rewrite.js";
import { logError } from "../log.js";

export function createResumeRoutes(config: Config, service: MatchService | undefined) {
  const settings = config.settings.resumeMatch;
  const allow = createRateLimiter(settings.requestsPerMinute);
  const routes = new Hono<AuthEnv>();
  routes.use("*", createAuth(config));

  const notConfigured = { detail: "Resume match is not configured on this server." };
  const logFailure = (what: string, error: unknown) =>
    // Log what failed, never the resume or job text.
    logError(`${what} failed`, error);

  // Multipart upload with a `file` field. The body limit stops oversized uploads before parsing.
  routes.post(
    "/extract",
    bodyLimit({ maxSize: settings.maxPdfBytes + 64 * 1024, onError: (c) => c.json({ detail: "The file is too large." }, 413) }),
    async (c) => {
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.file;
      if (!(file instanceof File)) return c.json({ detail: "Upload a PDF file in the `file` field." }, 400);
      try {
        return c.json({ text: await extractPdfText(new Uint8Array(await file.arrayBuffer()), settings) });
      } catch (error) {
        if (error instanceof ResumeInputError) return c.json({ detail: error.message }, 400);
        logFailure("pdf extract", error);
        return c.json({ detail: "The PDF could not be read." }, 500);
      }
    },
  );

  const jobTextBody = z.object({ url: z.string().trim().min(1).max(2000) });

  routes.post("/job-text", async (c) => {
    const parsed = jobTextBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: "Invalid request." }, 400);
    try {
      return c.json({ text: await fetchJobText(parsed.data.url, { ...settings.jobFetch, minJobChars: settings.minJobChars, maxJobChars: settings.maxJobChars }) });
    } catch (error) {
      if (error instanceof JobPageError) return c.json({ detail: error.message }, 422);
      logFailure("job page fetch", error);
      return c.json({ detail: "Couldn't read the job posting from that page. Paste the job description text instead." }, 422);
    }
  });

  // Lengths are checked by the service, which knows the limits and gives readable messages.
  const startBody = z.object({
    resumeText: z.string(),
    jobText: z.string(),
    jobUrl: z.string().url().max(2000).optional(),
    targetScore: z.number().int().min(50).max(100).optional(),
  });

  routes.post("/matches", async (c) => {
    if (!service) return c.json(notConfigured, 503);
    const parsed = startBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: "Invalid request." }, 400);
    if (!allow(c.get("userId"))) return c.json({ detail: "Too many requests. Wait a minute and try again." }, 429);
    try {
      return c.json(await service.start({ userId: c.get("userId"), jwt: c.get("jwt"), ...parsed.data }));
    } catch (error) {
      if (error instanceof ResumeInputError) return c.json({ detail: error.message }, 400);
      if (isQuotaError(error)) return c.json({ detail: "The AI model's usage limit is reached. Try again later." }, 503);
      logFailure("resume match", error);
      return c.json({ detail: "Couldn't score the resume right now. Try again." }, 502);
    }
  });

  routes.get("/matches", async (c) => {
    if (!service) return c.json(notConfigured, 503);
    try {
      return c.json({ matches: await service.list(c.get("userId"), c.get("jwt")) });
    } catch (error) {
      logFailure("list resume matches", error);
      return c.json({ detail: "Couldn't load your resume matches." }, 502);
    }
  });

  routes.get("/matches/:id", async (c) => {
    if (!service) return c.json(notConfigured, 503);
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ detail: "Resume match not found." }, 404);
    try {
      const match = await service.get(c.get("userId"), c.get("jwt"), id);
      return c.json({ ...viewOf(match, settings.maxRewrites), versions: match.versions });
    } catch (error) {
      if (error instanceof MatchNotFoundError) return c.json({ detail: error.message }, 404);
      logFailure("read resume match", error);
      return c.json({ detail: "Couldn't load that resume match." }, 502);
    }
  });

  // The skills the user confirmed, each with their own words about it. The details are checked by
  // the service, which knows the length limits and gives readable messages.
  const confirmation = z.object({ requirementId: z.number().int(), detail: z.string() });
  const confirmations = z.array(confirmation).max(50);
  const rewriteBody = z.object({ confirmed: confirmations });
  const acceptBody = z.object({ resumeText: z.string(), confirmed: confirmations, baseVersion: z.number().int().min(1) });

  // Shared by both model-backed match routes: parse the body, rate limit, run, translate errors.
  async function modelRoute<T>(c: Context<AuthEnv>, schema: z.ZodType<T>, what: string, run: (body: T, id: string) => Promise<unknown>) {
    if (!service) return c.json(notConfigured, 503);
    const id = c.req.param("id") ?? "";
    if (!z.string().uuid().safeParse(id).success) return c.json({ detail: "Resume match not found." }, 404);
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: "Invalid request." }, 400);
    if (!allow(c.get("userId"))) return c.json({ detail: "Too many requests. Wait a minute and try again." }, 429);
    try {
      return c.json(await run(parsed.data, id));
    } catch (error) {
      if (error instanceof MatchNotFoundError) return c.json({ detail: error.message }, 404);
      if (error instanceof ResumeInputError) return c.json({ detail: error.message }, 400);
      if (error instanceof VersionConflictError) return c.json({ detail: error.message }, 409);
      if (isQuotaError(error)) return c.json({ detail: "The AI model's usage limit is reached. Try again later." }, 503);
      logFailure(what, error);
      return c.json({ detail: "Couldn't do that right now. Try again." }, 502);
    }
  }

  routes.post("/matches/:id/rewrite", (c) =>
    modelRoute(c, rewriteBody, "resume rewrite", (body, id) => service!.rewrite(c.get("userId"), c.get("jwt"), id, body.confirmed)),
  );

  routes.post("/matches/:id/versions", (c) =>
    modelRoute(c, acceptBody, "resume version save", (body, id) => service!.accept(c.get("userId"), c.get("jwt"), id, body)),
  );

  // Puts a bullet under the role the user chose (no model, nothing saved): the text comes back for
  // the proposal view, and the user still accepts or edits it as usual.
  const placeBody = z.object({ resumeText: z.string().max(100000), under: z.string().max(500), bullet: z.string().max(1000) });
  routes.post("/place-bullet", async (c) => {
    const parsed = placeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: "Invalid request." }, 400);
    try {
      return c.json({ resumeText: placeBullet(parsed.data.resumeText, parsed.data.under, parsed.data.bullet) });
    } catch {
      return c.json({ detail: "Choose a line from your resume to put it under." }, 400);
    }
  });

  return routes;
}
