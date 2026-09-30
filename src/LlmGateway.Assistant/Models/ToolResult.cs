namespace LlmGateway.Assistant.Models;

// Answers one ToolCallRequest by Id. Persisted back as a ChatMessage with Role = "tool" and
// ToolCallId = ToolCallId (see docs/plan.md's `messages` table).
public class ToolResult
{
    public string ToolCallId { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public bool IsError { get; set; }
}
