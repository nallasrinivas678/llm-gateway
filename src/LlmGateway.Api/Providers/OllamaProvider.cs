using System.Diagnostics;
using System.Net.Http.Json;
using LlmGateway.Api.Cost;
using LlmGateway.Api.Models;
using Microsoft.Extensions.Options;

namespace LlmGateway.Api.Providers;

// Last resort in the fallback chain: a local model via Ollama's OpenAI-compatible API. No API key,
// no per-token cost - free as long as the model is already pulled locally.
public class OllamaProvider : ILlmProvider
{
    private readonly HttpClient _httpClient;
    private readonly OllamaOptions _options;

    public OllamaProvider(HttpClient httpClient, IOptions<OllamaOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    public string Name => "ollama";
    public int Priority => _options.Priority;

    public async Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
    {
        var payload = new OpenAiChatRequest
        {
            Model = _options.Model,
            Messages = request.Messages.Select(m => new OpenAiChatMessage { Role = m.Role, Content = m.Content }).ToList(),
            Temperature = request.Temperature
        };

        var stopwatch = Stopwatch.StartNew();
        using var httpResponse = await _httpClient.PostAsJsonAsync("v1/chat/completions", payload, cancellationToken);
        httpResponse.EnsureSuccessStatusCode();
        var ollamaResponse = await httpResponse.Content.ReadFromJsonAsync<OpenAiChatResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Ollama returned an empty response.");
        stopwatch.Stop();

        var content = ollamaResponse.Choices.FirstOrDefault()?.Message.Content ?? string.Empty;
        var usage = new UsageInfo
        {
            PromptTokens = ollamaResponse.Usage.PromptTokens,
            CompletionTokens = ollamaResponse.Usage.CompletionTokens,
            TotalTokens = ollamaResponse.Usage.TotalTokens
        };

        return new ChatCompletionResponse
        {
            Content = content,
            Model = _options.Model,
            Provider = Name,
            Usage = usage,
            CacheHit = false,
            LatencyMs = stopwatch.ElapsedMilliseconds,
            CostUsd = 0m
        };
    }
}
