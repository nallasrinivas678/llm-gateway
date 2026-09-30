using System.Text.Json;

namespace LlmGateway.Assistant.Tools;

// STUB - build order step 3. docs/plan.md says this "wraps TaskTide's existing `tasks` table",
// but that table's schema isn't in this plan (only the NEW tables in section 1 are). Confirm the
// actual columns (title? due_date? status enum values?) against TaskTide's existing schema before
// writing the SQL - the four classes below have inferred-but-unconfirmed argument schemas so the
// shape is ready, wired the same way SupabaseDataService uses NpgsqlDataSource once confirmed.

public class CreateTaskTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "dueDate": { "type": "string", "description": "ISO 8601 date, optional" }
          },
          "required": ["title"]
        }
        """).RootElement;

    public string Name => "create_task";
    public string Description => "Creates a new task for the user.";
    public JsonElement ParametersSchema => Schema;

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("CreateTaskTool - confirm TaskTide's `tasks` table schema first (see class comment).");
}

public class ListTasksTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""{ "type": "object", "properties": {} }""").RootElement;

    public string Name => "list_tasks";
    public string Description => "Lists the user's open tasks.";
    public JsonElement ParametersSchema => Schema;

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("ListTasksTool - confirm TaskTide's `tasks` table schema first (see class comment).");
}

public class CompleteTaskTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        { "type": "object", "properties": { "taskId": { "type": "string" } }, "required": ["taskId"] }
        """).RootElement;

    public string Name => "complete_task";
    public string Description => "Marks a task as complete.";
    public JsonElement ParametersSchema => Schema;

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("CompleteTaskTool - confirm TaskTide's `tasks` table schema first (see class comment).");
}

public class RescheduleTaskTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": { "taskId": { "type": "string" }, "newDueDate": { "type": "string", "description": "ISO 8601 date" } },
          "required": ["taskId", "newDueDate"]
        }
        """).RootElement;

    public string Name => "reschedule_task";
    public string Description => "Changes a task's due date.";
    public JsonElement ParametersSchema => Schema;

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("RescheduleTaskTool - confirm TaskTide's `tasks` table schema first (see class comment).");
}
