namespace LlmGateway.Assistant.Connectors;

public class SupabaseOptions
{
    // Postgres connection string using Supabase's service_role connection (bypasses RLS - see
    // docs/plan.md section 1's note on why that's safe: RLS protects direct client access, not
    // this trusted server).
    public string ConnectionString { get; set; } = string.Empty;
}
