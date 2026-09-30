namespace LlmGateway.Assistant.Models;

// A provider turn ends in exactly one of two ways: it produced a final text answer (Content
// non-empty, ToolCalls empty), or it wants tool(s) executed before it can continue (ToolCalls
// non-empty). ChatOrchestrator branches on which one it got.
public class ChatResponse
{
    public string Content { get; set; } = string.Empty;
    public List<ToolCallRequest> ToolCalls { get; set; } = new();
    public bool HasToolCalls => ToolCalls.Count > 0;
}
