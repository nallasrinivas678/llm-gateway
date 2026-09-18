namespace LlmGateway.Api.Models;

public class ChatCompletionResponse
{
    public string Content { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public UsageInfo Usage { get; set; } = new();
    public bool CacheHit { get; set; }
    public long LatencyMs { get; set; }
    public decimal CostUsd { get; set; }
}
