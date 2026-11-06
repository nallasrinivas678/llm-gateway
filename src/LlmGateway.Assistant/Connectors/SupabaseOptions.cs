namespace LlmGateway.Assistant.Connectors;

public class SupabaseOptions
{
    // Postgres connection string using Supabase's service_role connection (bypasses RLS - see
    // docs/plan.md section 1's note on why that's safe: RLS protects direct client access, not
    // this trusted server).
    public string ConnectionString { get; set; } = string.Empty;

    // Project URL and anon key, used to download PDFs from Storage with the user's own JWT.
    public string Url { get; set; } = string.Empty;
    public string AnonKey { get; set; } = string.Empty;
}
