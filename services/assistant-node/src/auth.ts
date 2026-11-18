import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Config } from "./config.js";

export type AuthEnv = { Variables: { userId: string; jwt: string } };

// Same rules as the .NET SupabaseJwtValidator: ES256 keys from the issuer's JWKS, with the
// HS256 shared secret as a fallback; audience is not checked; the user id is the `sub` claim.
export function createAuth(config: Config): MiddlewareHandler<AuthEnv> {
  const jwks = createRemoteJWKSet(new URL(`${config.SUPABASE_JWT_ISSUER}/.well-known/jwks.json`));
  const secret = config.SUPABASE_JWT_SECRET ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET) : null;

  return async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return c.json({ error: "Missing bearer token" }, 401);

    try {
      const options = { issuer: config.SUPABASE_JWT_ISSUER };
      let sub: string | undefined;
      try {
        sub = (await jwtVerify(token, jwks, options)).payload.sub;
      } catch (error) {
        if (!secret) throw error;
        sub = (await jwtVerify(token, secret, options)).payload.sub;
      }
      if (!sub) return c.json({ error: "Token has no subject" }, 401);
      c.set("userId", sub);
      c.set("jwt", token);
    } catch {
      return c.json({ error: "Invalid token" }, 401);
    }
    await next();
  };
}
