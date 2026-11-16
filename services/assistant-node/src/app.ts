import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuth, type AuthEnv } from "./auth.js";
import type { Config } from "./config.js";

export function createApp(config: Config) {
  const app = new Hono<AuthEnv>();

  app.use("*", cors({ origin: config.CORS_ALLOWED_ORIGINS, allowHeaders: ["Authorization", "Content-Type"] }));

  app.get("/health", (c) => c.json({ status: "healthy", timestampUtc: new Date().toISOString() }));

  // Everything under /assistant needs a valid Supabase JWT. Feature routes are added in later phases.
  const assistant = new Hono<AuthEnv>();
  assistant.use("*", createAuth(config));
  assistant.get("/whoami", (c) => c.json({ userId: c.get("userId") }));
  app.route("/assistant", assistant);

  return app;
}
