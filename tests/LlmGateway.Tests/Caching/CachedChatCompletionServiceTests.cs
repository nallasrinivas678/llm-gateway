using System.Text.Json;
using LlmGateway.Api.Caching;
using LlmGateway.Api.Models;
using LlmGateway.Api.Providers;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace LlmGateway.Tests.Caching;

public class CachedChatCompletionServiceTests
{
    [Fact]
    public async Task CompleteAsync_ServesSecondCallFromCache_ForDeterministicRequest()
    {
        var provider = new CountingProvider();
        var router = new LlmProviderRouter(new ILlmProvider[] { provider }, NullLogger<LlmProviderRouter>.Instance);
        var cache = new FakeCacheStore();
        var service = new CachedChatCompletionService(router, cache, Options.Create(new CacheOptions { DefaultTtlSeconds = 60 }));
        var request = BuildRequest(temperature: 0);

        var first = await service.CompleteAsync(request);
        var second = await service.CompleteAsync(request);

        Assert.False(first.CacheHit);
        Assert.True(second.CacheHit);
        Assert.Equal(1, provider.CallCount);
    }

    [Fact]
    public async Task CompleteAsync_NeverCaches_WhenTemperatureIsNonZero()
    {
        var provider = new CountingProvider();
        var router = new LlmProviderRouter(new ILlmProvider[] { provider }, NullLogger<LlmProviderRouter>.Instance);
        var cache = new FakeCacheStore();
        var service = new CachedChatCompletionService(router, cache, Options.Create(new CacheOptions()));
        var request = BuildRequest(temperature: 0.7);

        await service.CompleteAsync(request);
        await service.CompleteAsync(request);

        Assert.Equal(2, provider.CallCount);
        Assert.Empty(cache.Store);
    }

    private static ChatCompletionRequest BuildRequest(double temperature) => new()
    {
        Model = "gpt-4o-mini",
        Temperature = temperature,
        CallerId = "test",
        Messages = new List<ChatMessage> { new() { Role = "user", Content = "hi" } }
    };

    private class CountingProvider : ILlmProvider
    {
        public int CallCount { get; private set; }

        public string Name => "counting-provider";
        public int Priority => 0;

        public Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(new ChatCompletionResponse { Provider = Name, Model = request.Model, Content = "answer" });
        }
    }

    // Round-trips through JSON, like RedisCacheStore does, so a Get never returns the same object
    // reference a prior Set was given - mirrors the real cache's copy semantics.
    private class FakeCacheStore : ICacheStore
    {
        public Dictionary<string, string> Store { get; } = new();

        public Task<ChatCompletionResponse?> GetAsync(string key, CancellationToken cancellationToken = default) =>
            Task.FromResult(Store.TryGetValue(key, out var json) ? JsonSerializer.Deserialize<ChatCompletionResponse>(json) : null);

        public Task SetAsync(string key, ChatCompletionResponse response, TimeSpan ttl, CancellationToken cancellationToken = default)
        {
            Store[key] = JsonSerializer.Serialize(response);
            return Task.CompletedTask;
        }
    }
}
