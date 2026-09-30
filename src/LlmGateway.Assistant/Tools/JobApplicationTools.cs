using System.Text.Json;

namespace LlmGateway.Assistant.Tools;

// STUB - build order step 10, the last and most involved tool: "reads user_profiles, writes
// job_applications, drafts tailored resume/cover letter text via LLM (no auto-submit in v1)."
//
// Real implementation needs, in order:
//   1. Fetch the job posting content from `jobUrl` (no fetch-a-URL capability exists yet -
//      this is itself a dependency, likely shared with/adjacent to WebSearchTool).
//   2. Read the user's `user_profiles.resume_text` (table/columns already defined in
//      docs/plan.md section 1 - SupabaseDataService's pattern extends directly to this table).
//   3. Call an ILlmProvider (this project's own Providers/, not the gateway) with the job
//      posting + resume text to draft tailored resume/cover letter text.
//   4. INSERT into `job_applications` with status='tailored' (never auto-submit in v1, per plan).
public class DraftTailoredApplicationTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": {
            "jobUrl": { "type": "string" },
            "company": { "type": "string" },
            "jobTitle": { "type": "string" }
          },
          "required": ["jobUrl"]
        }
        """).RootElement;

    public string Name => "draft_tailored_application";
    public string Description => "Drafts a tailored resume and cover letter for a job posting, saved as a draft (never auto-submitted).";
    public JsonElement ParametersSchema => Schema;

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("DraftTailoredApplicationTool - see docs/plan.md build order step 10 and the class comment for the implementation sequence.");
}
