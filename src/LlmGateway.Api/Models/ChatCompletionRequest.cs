namespace LlmGateway.Api.Models;

public class ChatCompletionRequest
{
    public string Model { get; set; } = string.Empty;
    public List<ChatMessage> Messages { get; set; } = new();
    public double Temperature { get; set; } = 1.0;
    public string CallerId { get; set; } = string.Empty;
}
