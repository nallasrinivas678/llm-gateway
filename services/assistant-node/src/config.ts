import { z } from "zod";

// All settings come from environment variables (Fly secrets in production, .env locally).
// Names mirror the .NET gateway's appsettings keys where there is an equivalent.
const schema = z.object({
  PORT: z.coerce.number().default(8080),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),
  // Supabase JWT validation (same as SupabaseAuth:Issuer / SupabaseAuth:JwtSecret).
  SUPABASE_JWT_ISSUER: z.string().url(),
  SUPABASE_JWT_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}
