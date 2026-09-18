using System.Diagnostics;
using System.Net.Http.Json;
using LlmGateway.Api.Cost;
using LlmGateway.Api.Models;
using Microsoft.Extensions.Options;

namespace LlmGateway.Api.Providers;

public class OpenAiProvider : ILlmProvider
{
    private readonly HttpClient _httpClient;
    private readonly OpenAiOptions _options;

    public OpenAiProvider(HttpClient httpClient, IOptions<OpenAiOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    public string Name => "openai";
    public int Priority => _options.Priority;

    public async Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
    {
        var payload = new OpenAiChatRequest
        {
            Model = request.Model,
            Messages = request.Messages.Select(m => new OpenAiChatMessage { Role = m.Role, Content = m.Content }).ToList(),
            Temperature = request.Temperature
        };

        var stopwatch = Stopwatch.StartNew();
        using var httpResponse = await _httpClient.PostAsJsonAsync("v1/chat/completions", payload, cancellationToken);
        httpResponse.EnsureSuccessStatusCode();
        var openAiResponse = await httpResponse.Content.ReadFromJsonAsync<OpenAiChatResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("OpenAI returned an empty response.");
        stopwatch.Stop();

        var content = openAiResponse.Choices.FirstOrDefault()?.Message.Content ?? string.Empty;
        var usage = new UsageInfo
        {
            PromptTokens = openAiResponse.Usage.PromptTokens,
            CompletionTokens = openAiResponse.Usage.CompletionTokens,
            TotalTokens = openAiResponse.Usage.TotalTokens
        };

        return new ChatCompletionResponse
        {
            Content = content,
            Model = request.Model,
            Provider = Name,
            Usage = usage,
            CacheHit = false,
            LatencyMs = stopwatch.ElapsedMilliseconds,
            CostUsd = TokenPricing.Calculate(request.Model, usage.PromptTokens, usage.CompletionTokens)
        };
    }
}
