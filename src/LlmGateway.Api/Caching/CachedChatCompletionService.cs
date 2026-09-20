using System.Diagnostics;
using LlmGateway.Api.Models;
using LlmGateway.Api.Providers;
using Microsoft.Extensions.Options;

namespace LlmGateway.Api.Caching;

// Read-through cache in front of LlmProviderRouter: only deterministic (temperature 0) requests
// are cacheable, matching the README's "Caching" design - a non-zero temperature means the
// provider itself doesn't promise the same output twice, so serving a stale cached answer would
// be wrong, not just imprecise.
public class CachedChatCompletionService
{
    private readonly LlmProviderRouter _router;
    private readonly ICacheStore _cache;
    private readonly CacheOptions _options;

    public CachedChatCompletionService(LlmProviderRouter router, ICacheStore cache, IOptions<CacheOptions> options)
    {
        _router = router;
        _cache = cache;
        _options = options.Value;
    }

    public async Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
    {
        if (!IsCacheable(request))
        {
            return await _router.CompleteAsync(request, cancellationToken);
        }

        var key = CacheKeyGenerator.Generate(request);
        var stopwatch = Stopwatch.StartNew();
        var cached = await _cache.GetAsync(key, cancellationToken);
        if (cached is not null)
        {
            stopwatch.Stop();
            cached.CacheHit = true;
            cached.LatencyMs = stopwatch.ElapsedMilliseconds;
            return cached;
        }

        var response = await _router.CompleteAsync(request, cancellationToken);
        await _cache.SetAsync(key, response, TimeSpan.FromSeconds(_options.DefaultTtlSeconds), cancellationToken);
        return response;
    }

    private static bool IsCacheable(ChatCompletionRequest request) => request.Temperature == 0;
}
