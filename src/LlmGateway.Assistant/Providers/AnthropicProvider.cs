using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using LlmGateway.Assistant.Models;
using Microsoft.Extensions.Options;

namespace LlmGateway.Assistant.Providers;

// Talks to Anthropic's native Messages API (not the gateway's OpenAI-compatible wire format),
// since tool-use round-trips need Anthropic's own content-block shapes: an assistant turn that
// calls a tool is a "tool_use" content block, and the answer to it is a "tool_result" block on
// the NEXT user-role turn (Anthropic has no separate "tool" role, unlike OpenAI/our own
// ChatMessage.Role="tool" convention - that mapping happens in BuildMessages below).
public class AnthropicProvider : ILlmProvider
{
    private readonly HttpClient _httpClient;
    private readonly AnthropicOptions _options;

    public AnthropicProvider(HttpClient httpClient, IOptions<AnthropicOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    public async Task<ChatResponse> CompleteAsync(ChatRequest request, CancellationToken cancellationToken = default)
    {
        var payload = new AnthropicRequest
        {
            Model = _options.Model,
            MaxTokens = _options.MaxTokens,
            System = request.SystemPrompt,
            Messages = BuildMessages(request.Messages),
            Tools = request.Tools.Count == 0 ? null : request.Tools.ConvertAll(t => new AnthropicTool
            {
                Name = t.Name,
                Description = t.Description,
                InputSchema = t.ParametersSchema
            })
        };

        using var httpResponse = await _httpClient.PostAsJsonAsync("v1/messages", payload, cancellationToken);
        httpResponse.EnsureSuccessStatusCode();
        var anthropicResponse = await httpResponse.Content.ReadFromJsonAsync<AnthropicResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Anthropic returned an empty response.");

        var response = new ChatResponse();
        foreach (var block in anthropicResponse.Content)
        {
            if (block.Type == "text" && block.Text is not null)
            {
                response.Content += block.Text;
            }
            else if (block.Type == "tool_use" && block.Id is not null && block.Name is not null)
            {
                response.ToolCalls.Add(new ToolCallRequest
                {
                    Id = block.Id,
                    ToolName = block.Name,
                    ArgumentsJson = block.Input?.GetRawText() ?? "{}"
                });
            }
        }

        return response;
    }

    // Anthropic has no "tool" role: a tool result is a user-role turn carrying a tool_result
    // block, and a prior assistant tool call is an assistant-role turn carrying a tool_use block.
    private static List<AnthropicMessage> BuildMessages(IEnumerable<ChatMessage> messages)
    {
        var result = new List<AnthropicMessage>();

        foreach (var message in messages)
        {
            if (message.Role == "tool")
            {
                result.Add(new AnthropicMessage
                {
                    Role = "user",
                    Content = JsonSerializer.SerializeToElement(new[]
                    {
                        new
                        {
                            type = "tool_result",
                            tool_use_id = message.ToolCallId,
                            content = message.Content
                        }
                    })
                });
            }
            else if (message.Role == "assistant" && message.ToolCalls is { Count: > 0 })
            {
                var blocks = message.ToolCalls.Select(tc => (object)new
                {
                    type = "tool_use",
                    id = tc.Id,
                    name = tc.ToolName,
                    input = JsonSerializer.Deserialize<JsonElement>(tc.ArgumentsJson)
                }).ToList();

                result.Add(new AnthropicMessage { Role = "assistant", Content = JsonSerializer.SerializeToElement(blocks) });
            }
            else
            {
                result.Add(new AnthropicMessage { Role = message.Role, Content = JsonSerializer.SerializeToElement(message.Content) });
            }
        }

        return result;
    }

    private class AnthropicRequest
    {
        [JsonPropertyName("model")]
        public string Model { get; set; } = string.Empty;

        [JsonPropertyName("max_tokens")]
        public int MaxTokens { get; set; }

        [JsonPropertyName("system")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public string? System { get; set; }

        [JsonPropertyName("messages")]
        public List<AnthropicMessage> Messages { get; set; } = new();

        [JsonPropertyName("tools")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public List<AnthropicTool>? Tools { get; set; }
    }

    private class AnthropicMessage
    {
        [JsonPropertyName("role")]
        public string Role { get; set; } = string.Empty;

        // Either a plain string (simple text turn) or a content-block array (tool_use/tool_result) -
        // both are valid Anthropic message content shapes, so this stays a raw JsonElement.
        [JsonPropertyName("content")]
        public JsonElement Content { get; set; }
    }

    private class AnthropicTool
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = string.Empty;

        [JsonPropertyName("description")]
        public string Description { get; set; } = string.Empty;

        [JsonPropertyName("input_schema")]
        public JsonElement InputSchema { get; set; }
    }

    private class AnthropicResponse
    {
        [JsonPropertyName("content")]
        public List<AnthropicContentBlock> Content { get; set; } = new();
    }

    private class AnthropicContentBlock
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty;

        [JsonPropertyName("text")]
        public string? Text { get; set; }

        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("input")]
        public JsonElement? Input { get; set; }
    }
}
