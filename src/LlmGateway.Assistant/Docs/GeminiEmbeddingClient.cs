using System.Net.Http.Json;
using System.Text.Json.Serialization;
using LlmGateway.Assistant.Providers;
using Microsoft.Extensions.Options;

namespace LlmGateway.Assistant.Docs;

// Gemini batchEmbedContents. Model and dimensions live in GeminiOptions; the dimensions must
// match document_chunks.embedding (vector(1536)).
public class GeminiEmbeddingClient
{
    private readonly HttpClient _httpClient;
    private readonly GeminiOptions _options;

    public GeminiEmbeddingClient(HttpClient httpClient, IOptions<GeminiOptions> options)
    {
        _httpClient = httpClient;
        _options = options.Value;
    }

    // taskType: RETRIEVAL_DOCUMENT for chunks, RETRIEVAL_QUERY for questions.
    public async Task<List<float[]>> EmbedAsync(IReadOnlyList<string> texts, string taskType, CancellationToken cancellationToken = default)
    {
        var body = new
        {
            requests = texts.Select(text => new
            {
                model = $"models/{_options.EmbeddingModel}",
                content = new { parts = new[] { new { text } } },
                taskType,
                outputDimensionality = _options.EmbeddingDimensions
            })
        };

        // One retry after a short pause covers transient 429/5xx; anything more is out of scope here.
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post,
                    $"v1beta/models/{_options.EmbeddingModel}:batchEmbedContents")
                {
                    Content = JsonContent.Create(body)
                };
                request.Headers.Add("x-goog-api-key", _options.ApiKey);

                using var response = await _httpClient.SendAsync(request, cancellationToken);
                response.EnsureSuccessStatusCode();
                var parsed = await response.Content.ReadFromJsonAsync<BatchResponse>(cancellationToken: cancellationToken)
                    ?? throw new InvalidOperationException("Gemini returned an empty embeddings response.");
                if (parsed.Embeddings.Count != texts.Count)
                {
                    throw new InvalidOperationException($"Gemini returned {parsed.Embeddings.Count} embeddings for {texts.Count} inputs.");
                }

                return parsed.Embeddings.Select(e => e.Values).ToList();
            }
            catch (HttpRequestException) when (attempt == 1)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
        }
    }

    private class BatchResponse
    {
        [JsonPropertyName("embeddings")] public List<Embedding> Embeddings { get; set; } = new();
    }

    private class Embedding
    {
        [JsonPropertyName("values")] public float[] Values { get; set; } = Array.Empty<float>();
    }
}
