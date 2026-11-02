using LlmGateway.Assistant.Models;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace LlmGateway.Assistant.DailySummary;

// In-process cache (per Fly machine, not shared) - a short-term fix for first-load latency.
// Good enough for this app's scale; see IDailySummaryCache's remarks if cross-machine hit rate
// or surviving a deploy ever matters, which would mean swapping this for a durable store instead.
public class MemoryDailySummaryCache : IDailySummaryCache
{
    private const string KeyPrefix = "daily-summary:";

    private readonly IMemoryCache _cache;
    private readonly DailySummaryOptions _options;

    public MemoryDailySummaryCache(IMemoryCache cache, IOptions<DailySummaryOptions> options)
    {
        _cache = cache;
        _options = options.Value;
    }

    public Task<DailySummaryResponseDto?> GetAsync(Guid userId, CancellationToken cancellationToken = default) =>
        Task.FromResult(_cache.TryGetValue(BuildKey(userId), out DailySummaryResponseDto? cached) ? cached : null);

    public Task SetAsync(Guid userId, DailySummaryResponseDto response, CancellationToken cancellationToken = default)
    {
        _cache.Set(BuildKey(userId), response, TimeSpan.FromSeconds(_options.CacheTtlSeconds));
        return Task.CompletedTask;
    }

    private static string BuildKey(Guid userId) => KeyPrefix + userId;
}
