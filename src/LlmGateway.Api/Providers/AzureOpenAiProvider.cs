using System.Diagnostics;
using System.Net.Http.Json;
using LlmGateway.Api.Cost;
using LlmGateway.Api.Models;
using Microsoft.Extensions.Options;

namespace LlmGateway.Api.Providers;

public class AzureOpenAiProvider : ILlmProvider
{
    private readonly HttpClient _httpClient;
    private readonly AzureOpenAiOptions _options;

    public AzureOpenAiProvider(HttpClient httpClient, IOptions<AzureOpenAiOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    public string Name => "azure-openai";
    public int Priority => _options.Priority;

    public async Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
    {
        var requestUri = $"openai/deployments/{Uri.EscapeDataString(request.Model)}/chat/completions?api-version={_options.ApiVersion}";
        var payload = new OpenAiChatRequest
        {
            Messages = request.Messages.Select(m => new OpenAiChatMessage { Role = m.Role, Content = m.Content }).ToList(),
            Temperature = request.Temperature
        };

        var stopwatch = Stopwatch.StartNew();
        using var httpResponse = await _httpClient.PostAsJsonAsync(requestUri, payload, cancellationToken);
        httpResponse.EnsureSuccessStatusCode();
        var azureResponse = await httpResponse.Content.ReadFromJsonAsync<OpenAiChatResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Azure OpenAI returned an empty response.");
        stopwatch.Stop();

        var content = azureResponse.Choices.FirstOrDefault()?.Message.Content ?? string.Empty;
        var usage = new UsageInfo
        {
            PromptTokens = azureResponse.Usage.PromptTokens,
            CompletionTokens = azureResponse.Usage.CompletionTokens,
            TotalTokens = azureResponse.Usage.TotalTokens
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
