using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using LlmGateway.Assistant.Models;
using Microsoft.Extensions.Options;

namespace LlmGateway.Assistant.Providers;

// Talks to Gemini's generateContent API. Two protocol quirks vs. Anthropic/OpenAI worth knowing:
// (1) Gemini's role names are "user"/"model", not "user"/"assistant".
// (2) Gemini's functionCall/functionResponse pairing has no call-id concept - it matches by
//     function NAME. We still populate ToolCallRequest.Id (our own model requires it) by reusing
//     the function name as a pseudo-id, and match functionResponse back to it the same way.
public class GeminiProvider : ILlmProvider
{
    private readonly HttpClient _httpClient;
    private readonly GeminiOptions _options;

    public GeminiProvider(HttpClient httpClient, IOptions<GeminiOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    public async Task<ChatResponse> CompleteAsync(ChatRequest request, CancellationToken cancellationToken = default)
    {
        var payload = new GeminiRequest
        {
            Contents = BuildContents(request.Messages),
            SystemInstruction = request.SystemPrompt is null
                ? null
                : new GeminiContent { Parts = new List<GeminiPart> { new() { Text = request.SystemPrompt } } },
            Tools = request.Tools.Count == 0
                ? null
                : new List<GeminiToolDeclaration>
                {
                    new()
                    {
                        FunctionDeclarations = request.Tools.ConvertAll(t => new GeminiFunctionDeclaration
                        {
                            Name = t.Name,
                            Description = t.Description,
                            Parameters = t.ParametersSchema
                        })
                    }
                }
        };

        var requestUri = $"v1beta/models/{_options.Model}:generateContent";
        using var httpRequestMessage = new HttpRequestMessage(HttpMethod.Post, requestUri)
        {
            Content = JsonContent.Create(payload)
        };
        httpRequestMessage.Headers.Add("x-goog-api-key", _options.ApiKey);

        using var httpResponse = await _httpClient.SendAsync(httpRequestMessage, cancellationToken);
        httpResponse.EnsureSuccessStatusCode();
        var geminiResponse = await httpResponse.Content.ReadFromJsonAsync<GeminiResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Gemini returned an empty response.");

        var response = new ChatResponse();
        var parts = geminiResponse.Candidates.FirstOrDefault()?.Content.Parts ?? new List<GeminiPart>();
        foreach (var part in parts)
        {
            if (part.Text is not null)
            {
                response.Content += part.Text;
            }
            else if (part.FunctionCall is not null)
            {
                response.ToolCalls.Add(new ToolCallRequest
                {
                    Id = part.FunctionCall.Name,
                    ToolName = part.FunctionCall.Name,
                    ArgumentsJson = part.FunctionCall.Args.GetRawText()
                });
            }
        }

        return response;
    }

    private static List<GeminiContent> BuildContents(IEnumerable<ChatMessage> messages)
    {
        var result = new List<GeminiContent>();

        foreach (var message in messages)
        {
            if (message.Role == "tool")
            {
                result.Add(new GeminiContent
                {
                    Role = "user",
                    Parts = new List<GeminiPart>
                    {
                        new()
                        {
                            FunctionResponse = new GeminiFunctionResponse
                            {
                                Name = message.ToolCallId ?? string.Empty,
                                Response = JsonSerializer.SerializeToElement(new { content = message.Content })
                            }
                        }
                    }
                });
            }
            else if (message.Role == "assistant" && message.ToolCalls is { Count: > 0 })
            {
                result.Add(new GeminiContent
                {
                    Role = "model",
                    Parts = message.ToolCalls.Select(tc => new GeminiPart
                    {
                        FunctionCall = new GeminiFunctionCall
                        {
                            Name = tc.ToolName,
                            Args = JsonSerializer.Deserialize<JsonElement>(tc.ArgumentsJson)
                        }
                    }).ToList()
                });
            }
            else
            {
                result.Add(new GeminiContent
                {
                    Role = message.Role == "assistant" ? "model" : "user",
                    Parts = new List<GeminiPart> { new() { Text = message.Content } }
                });
            }
        }

        return result;
    }

    private class GeminiRequest
    {
        [JsonPropertyName("contents")]
        public List<GeminiContent> Contents { get; set; } = new();

        [JsonPropertyName("systemInstruction")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public GeminiContent? SystemInstruction { get; set; }

        [JsonPropertyName("tools")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<GeminiToolDeclaration>? Tools { get; set; }
    }

    private class GeminiContent
    {
        [JsonPropertyName("role")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Role { get; set; }

        [JsonPropertyName("parts")]
        public List<GeminiPart> Parts { get; set; } = new();
    }

    private class GeminiPart
    {
        [JsonPropertyName("text")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? Text { get; set; }

        [JsonPropertyName("functionCall")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public GeminiFunctionCall? FunctionCall { get; set; }

        [JsonPropertyName("functionResponse")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public GeminiFunctionResponse? FunctionResponse { get; set; }
    }

    private class GeminiFunctionCall
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("args")]
        public JsonElement Args { get; set; }
    }

    private class GeminiFunctionResponse
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("response")]
        public JsonElement Response { get; set; }
    }

    private class GeminiToolDeclaration
    {
        [JsonPropertyName("functionDeclarations")]
        public List<GeminiFunctionDeclaration> FunctionDeclarations { get; set; } = new();
    }

    private class GeminiFunctionDeclaration
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("description")]
        public string Description { get; set; } = string.Empty;

        [JsonPropertyName("parameters")]
        public JsonElement Parameters { get; set; }
    }

    private class GeminiResponse
    {
        [JsonPropertyName("candidates")]
        public List<GeminiCandidate> Candidates { get; set; } = new();
    }

    private class GeminiCandidate
    {
        [JsonPropertyName("content")]
        public GeminiContent Content { get; set; } = new();
    }
}
