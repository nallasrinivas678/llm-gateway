namespace LlmGateway.Api.Cost;

public class UsageSummary
{
    public string CallerId { get; set; } = string.Empty;
    public DateTimeOffset From { get; set; }
    public DateTimeOffset To { get; set; }
    public int TotalRequests { get; set; }
    public long TotalPromptTokens { get; set; }
    public long TotalCompletionTokens { get; set; }
    public long TotalTokens { get; set; }
    public decimal TotalCostUsd { get; set; }
}
