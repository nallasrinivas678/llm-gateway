using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.DailySummary;

// Used when DailySummary:CacheEnabled is false. Every lookup misses and every write is a no-op.
public class NullDailySummaryCache : IDailySummaryCache
{
    public Task<DailySummaryResponseDto?> GetAsync(Guid userId, CancellationToken cancellationToken = default) =>
        Task.FromResult<DailySummaryResponseDto?>(null);

    public Task SetAsync(Guid userId, DailySummaryResponseDto response, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;
}
