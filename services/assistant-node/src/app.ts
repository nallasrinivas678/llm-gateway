import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createAuth, type AuthEnv } from "./auth.js";
import type { ChatService } from "./chat/chatService.js";
import { ConversationNotFoundError } from "./chat/conversationStore.js";
import type { Config } from "./config.js";

interface Services {
  // Missing when the secrets chat needs are not set; the route then answers 503.
  chat?: ChatService;
}

export function createApp(config: Config, services: Services = {}) {
  const app = new Hono<AuthEnv>();

  app.use("*", cors({ origin: config.CORS_ALLOWED_ORIGINS, allowHeaders: ["Authorization", "Content-Type"] }));

  app.get("/health", (c) => c.json({ status: "healthy", timestampUtc: new Date().toISOString() }));

  // Everything under /assistant needs a valid Supabase JWT.
  const assistant = new Hono<AuthEnv>();
  assistant.use("*", createAuth(config));
  assistant.get("/whoami", (c) => c.json({ userId: c.get("userId") }));

  // Same request and response shape as the .NET POST /assistant/chat.
  const chatBody = z.object({
    conversationId: z.string().uuid().nullish(),
    message: z.string().trim().min(1).max(config.settings.chat.maxMessageLength),
  });

  assistant.post("/chat", async (c) => {
    if (!services.chat) return c.json({ error: "Chat is not configured on this server." }, 503);

    const parsed = chatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid request." }, 400);

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
      // Log what failed, never what the user said.
      console.error("chat failed:", error instanceof Error ? `${error.name}: ${error.message.slice(0, 200)}` : "unknown error");
      return c.json({ error: "The assistant could not complete the request." }, 502);
    }
  });

  app.route("/assistant", assistant);

  return app;
}
