using System.Text.Json.Serialization;

namespace LlmGateway.Api.Providers;

// Shared wire format for the OpenAI-compatible chat completions API. Azure OpenAI and
// OpenAI both use this request/response shape, so both providers serialize through it.
internal class OpenAiChatRequest
{
    [JsonPropertyName("messages")]
    public List<OpenAiChatMessage> Messages { get; set; } = new();

    [JsonPropertyName("temperature")]
    public double Temperature { get; set; }

    // Azure OpenAI infers the model from the deployment in the URL, so this is omitted for
    // that provider; the direct OpenAI API requires it in the request body.
    [JsonPropertyName("model")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Model { get; set; }
}

internal class OpenAiChatMessage
{
    [JsonPropertyName("role")]
    public string Role { get; set; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; set; } = string.Empty;
}

internal class OpenAiChatResponse
{
    [JsonPropertyName("choices")]
    public List<OpenAiChatChoice> Choices { get; set; } = new();

    [JsonPropertyName("usage")]
    public OpenAiChatUsage Usage { get; set; } = new();
}

internal class OpenAiChatChoice
{
    [JsonPropertyName("message")]
    public OpenAiChatMessage Message { get; set; } = new();
}

internal class OpenAiChatUsage
{
    [JsonPropertyName("prompt_tokens")]
    public int PromptTokens { get; set; }

    [JsonPropertyName("completion_tokens")]
    public int CompletionTokens { get; set; }

    [JsonPropertyName("total_tokens")]
    public int TotalTokens { get; set; }
}
