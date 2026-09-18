using LlmGateway.Api.Models;
using Newtonsoft.Json;

namespace LlmGateway.Api.Cost;

public class RequestLogEntry
{
    [JsonProperty("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString();

    public string CallerId { get; set; } = string.Empty;
    public string Model { get; set; } = string.Empty;
    public string Provider { get; set; } = string.Empty;
    public int PromptTokens { get; set; }
    public int CompletionTokens { get; set; }
    public int TotalTokens { get; set; }
    public bool CacheHit { get; set; }
    public long LatencyMs { get; set; }
    public decimal CostUsd { get; set; }
    public string Outcome { get; set; } = "success";
    public string? ErrorMessage { get; set; }
    public DateTimeOffset TimestampUtc { get; set; } = DateTimeOffset.UtcNow;

    public static RequestLogEntry FromSuccess(ChatCompletionRequest request, ChatCompletionResponse response, long latencyMs) => new()
    {
        CallerId = request.CallerId,
        Model = response.Model,
        Provider = response.Provider,
        PromptTokens = response.Usage.PromptTokens,
        CompletionTokens = response.Usage.CompletionTokens,
        TotalTokens = response.Usage.TotalTokens,
        CacheHit = response.CacheHit,
        LatencyMs = latencyMs,
        CostUsd = response.CostUsd,
        Outcome = "success"
    };

    public static RequestLogEntry FromFailure(ChatCompletionRequest request, Exception ex, long latencyMs) => new()
    {
        CallerId = request.CallerId,
        Model = request.Model,
        Provider = "none",
        LatencyMs = latencyMs,
        Outcome = "error",
        ErrorMessage = ex.Message
    };
}
