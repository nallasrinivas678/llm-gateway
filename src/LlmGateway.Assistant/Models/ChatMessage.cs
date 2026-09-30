namespace LlmGateway.Assistant.Models;

// Mirrors the shape of the `messages` table (see docs/plan.md section 1) - a message is either a
// plain user/assistant turn, or a tool round-trip (assistant requests ToolCalls, a later "tool"
// role message answers one of them via ToolCallId).
public class ChatMessage
{
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string? ToolCallId { get; set; }
    public List<ToolCallRequest>? ToolCalls { get; set; }
}
