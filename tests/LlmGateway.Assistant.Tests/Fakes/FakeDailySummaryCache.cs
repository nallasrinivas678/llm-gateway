using LlmGateway.Assistant.DailySummary;
using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.Tests.Fakes;

public class FakeDailySummaryCache : IDailySummaryCache
{
    private readonly Dictionary<Guid, DailySummaryResponseDto> _entries = new();

    public int SetCallCount { get; private set; }

    public Task<DailySummaryResponseDto?> GetAsync(Guid userId, CancellationToken cancellationToken = default) =>
        Task.FromResult(_entries.TryGetValue(userId, out var cached) ? cached : null);

    public Task SetAsync(Guid userId, DailySummaryResponseDto response, CancellationToken cancellationToken = default)
    {
        _entries[userId] = response;
        SetCallCount++;
        return Task.CompletedTask;
    }
}
