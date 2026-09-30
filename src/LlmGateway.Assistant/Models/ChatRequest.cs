namespace LlmGateway.Assistant.Models;

// Provider-level request (what ILlmProvider implementations consume) - not the public
// POST /assistant/chat wire shape, which is much thinner (see Endpoints/ChatController.cs).
public class ChatRequest
{
    public List<ChatMessage> Messages { get; set; } = new();
    public List<ToolSchema> Tools { get; set; } = new();
    public string? SystemPrompt { get; set; }
}
