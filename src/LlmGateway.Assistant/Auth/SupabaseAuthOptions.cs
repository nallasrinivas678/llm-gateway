namespace LlmGateway.Assistant.Auth;

public class SupabaseAuthOptions
{
    // Supabase project settings -> API -> JWT Secret. HS256-signed, so this is a shared secret,
    // not a public key - treat it like any other credential (user-secrets locally, Key Vault in prod).
    public string JwtSecret { get; set; } = string.Empty;

    // e.g. "https://<project-ref>.supabase.co/auth/v1". Left empty, issuer validation is skipped -
    // fine for local dev, but set this in every real deployment.
    public string Issuer { get; set; } = string.Empty;
}
