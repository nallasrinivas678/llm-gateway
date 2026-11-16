import { readFileSync } from "node:fs";
import { z } from "zod";

// Two sources, one rule: config/default.json holds the non-secret settings that are the same in
// every environment (API URLs, limits, defaults). Environment variables hold secrets and anything
// that differs per environment, and win over the file where both exist.

const httpsUrl = z.string().url().refine((value) => value.startsWith("https://"), "must start with https://");
const positiveInt = z.number().int().positive();

export const settingsSchema = z.object({
  server: z.object({ port: positiveInt }),
  cors: z.object({ allowedOrigins: z.array(z.string().url()).min(1) }),
  google: z.object({
    urls: z.object({
      calendarEvents: httpsUrl,
      gmailMessages: httpsUrl,
      gmailDrafts: httpsUrl,
      docsDocuments: httpsUrl,
    }),
    limits: z.object({
      calendar: z
        .object({ defaultEvents: positiveInt, maxEvents: positiveInt, maxSummaryLength: positiveInt, maxDescriptionLength: positiveInt })
        .refine((c) => c.defaultEvents <= c.maxEvents, "defaultEvents must not exceed maxEvents"),
      gmail: z
        .object({ defaultResults: positiveInt, maxResults: positiveInt, maxQueryLength: positiveInt, maxSubjectLength: positiveInt, maxBodyLength: positiveInt })
        .refine((g) => g.defaultResults <= g.maxResults, "defaultResults must not exceed maxResults"),
      docs: z.object({ maxReadChars: positiveInt, maxAppendChars: positiveInt }),
    }),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;
export type GoogleSettings = Settings["google"];

export function parseSettings(raw: unknown): Settings {
  return settingsSchema.parse(raw);
}

// The file sits next to `src` (and next to `dist` once built), so the same path works for both.
export function loadSettings(file: URL = new URL("../config/default.json", import.meta.url)): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read settings file ${file.pathname}: ${(error as Error).message}`);
  }
  return parseSettings(raw);
}

// A blank line like `PORT=` in a .env file means "not set", not "zero".
const blankIsUnset = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const envSchema = z.object({
  PORT: z.preprocess(blankIsUnset, z.coerce.number().int().positive().optional()),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Supabase JWT validation (same as SupabaseAuth:Issuer / SupabaseAuth:JwtSecret in .NET).
  SUPABASE_JWT_ISSUER: z.string().url(),
  SUPABASE_JWT_SECRET: z.string().optional(),
});

const splitList = (value?: string) => {
  const items = (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
};

// Fails fast at startup on a missing or invalid setting.
export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: Settings = loadSettings()) {
  const parsed = envSchema.parse(env);
  return {
    PORT: parsed.PORT ?? settings.server.port,
    CORS_ALLOWED_ORIGINS: splitList(parsed.CORS_ALLOWED_ORIGINS) ?? settings.cors.allowedOrigins,
    SUPABASE_JWT_ISSUER: parsed.SUPABASE_JWT_ISSUER,
    SUPABASE_JWT_SECRET: parsed.SUPABASE_JWT_SECRET,
    settings,
  };
}

export type Config = ReturnType<typeof loadConfig>;
