import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createAuth, type AuthEnv } from "./auth.js";
import { ConversationNotFoundError } from "./chat/conversationStore.js";
import type { Config } from "./config.js";
import { SummaryUnavailableError } from "./dailySummary/dailySummaryService.js";
import { GoogleConnectError, InvalidStateError } from "./google-oauth/connectService.js";
import { createDocRoutes } from "./docQa/routes.js";
import { createRateLimiter } from "./resumeMatch/generate.js";
import { createResumeRoutes } from "./resumeMatch/routes.js";
import type { Services } from "./wiring.js";

export function createApp(config: Config, services: Services = {}) {
  const app = new Hono<AuthEnv>();

  app.use("*", cors({ origin: config.CORS_ALLOWED_ORIGINS, allowHeaders: ["Authorization", "Content-Type"] }));

  app.get("/health", (c) => c.json({ status: "healthy", timestampUtc: new Date().toISOString() }));

  // Everything under /assistant needs a valid Supabase JWT.
  const assistant = new Hono<AuthEnv>();
  assistant.use("*", createAuth(config));
  assistant.get("/whoami", (c) => c.json({ userId: c.get("userId") }));

  // PDF Q&A: POST /assistant/docs (ingest) and POST /assistant/docs/ask, same as the .NET service.
  assistant.route("/docs", createDocRoutes(services.docQa, config.settings.docQa));

  // Same request and response shape as the .NET POST /assistant/chat.
  const chatBody = z.object({
    conversationId: z.string().uuid().nullish(),
    message: z.string().trim().min(1).max(config.settings.chat.maxMessageLength),
  });

  const allowChat = createRateLimiter(config.settings.chat.requestsPerMinute);

  assistant.post("/chat", async (c) => {
    if (!services.chat) return c.json({ error: "Chat is not configured on this server." }, 503);

    const parsed = chatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid request." }, 400);
    if (!allowChat(c.get("userId"))) return c.json({ error: "Too many messages. Wait a minute and try again." }, 429);

    try {
      const result = await services.chat.chat({
        userId: c.get("userId"),
        jwt: c.get("jwt"),
        conversationId: parsed.data.conversationId ?? undefined,
        message: parsed.data.message,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof ConversationNotFoundError) return c.json({ error: "Conversation not found." }, 404);
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return c.json({ error: "The assistant took too long. Try again." }, 504);
      // Log what failed, never what the user said.
      console.error("chat failed:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error");
      return c.json({ error: "The assistant could not complete the request." }, 502);
    }
  });

  // Daily summary: same JSON and SSE events as the .NET endpoints. Errors carry a `detail`.
  const summaryFailure = (error: unknown) => {
    if (error instanceof SummaryUnavailableError) return error.message;
    console.error("daily summary failed:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error");
    return "The daily summary could not be generated.";
  };

  assistant.get("/daily-summary", async (c) => {
    if (!services.dailySummary) return c.json({ detail: "The daily summary is not configured on this server." }, 503);
    try {
      return c.json(await services.dailySummary.build(c.get("userId"), c.req.raw.signal));
    } catch (error) {
      return c.json({ detail: summaryFailure(error) }, 502);
    }
  });

  assistant.get("/daily-summary/stream", (c) => {
    const summary = services.dailySummary;
    if (!summary) return c.json({ detail: "The daily summary is not configured on this server." }, 503);

    c.header("X-Accel-Buffering", "no");   // keep proxies from holding the stream back
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of summary.stream(c.get("userId"), c.req.raw.signal)) {
          const data = event.type === "status" ? { message: event.message } : event.type === "chunk" ? { text: event.text } : event.result;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(data) });
        }
      } catch (error) {
        // The client leaving is not an error worth reporting.
        if (c.req.raw.signal.aborted) return;
        await stream.writeSSE({ event: "error", data: JSON.stringify({ detail: summaryFailure(error) }) });
      }
    });
  });

  // Connect Google: same paths as the .NET service. /start gives the browser a Google consent
  // URL; /exchange receives the code the web app got back and saves the tokens.
  const googleAuth = new Hono<AuthEnv>();
  googleAuth.use("*", createAuth(config));

  googleAuth.get("/start", async (c) => {
    if (!services.googleConnect) return c.json({ detail: "Connecting Google is not configured on this server." }, 503);
    return c.json({ authorizationUrl: await services.googleConnect.buildAuthorizationUrl(c.get("userId")) });
  });

  const exchangeBody = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(4000) });

  googleAuth.post("/exchange", async (c) => {
    if (!services.googleConnect) return c.json({ detail: "Connecting Google is not configured on this server." }, 503);

    const parsed = exchangeBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ detail: "Invalid request." }, 400);

    try {
      await services.googleConnect.complete(c.get("userId"), parsed.data.code, parsed.data.state);
      return c.json({ connected: true });
    } catch (error) {
      if (error instanceof InvalidStateError) return c.json({ detail: error.message }, 400);
      if (error instanceof GoogleConnectError) return c.json({ detail: error.message }, 502);
      console.error("google connect failed:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error");
      return c.json({ detail: "Could not connect your Google account." }, 502);
    }
  });

  app.route("/auth/google", googleAuth);
  app.route("/resume", createResumeRoutes(config, services.resumeMatch));
  app.route("/assistant", assistant);

  return app;
}
