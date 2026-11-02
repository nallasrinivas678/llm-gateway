using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.DailySummary;

// Caches the assembled DailySummaryResponseDto per user, so a repeat dashboard load within the
// TTL skips the Gmail/Calendar fetch and the Gemini call entirely instead of just serving a
// cached LLM completion. See DailySummaryService.BuildAsync/StreamAsync for the read-through.
public interface IDailySummaryCache
{
    Task<DailySummaryResponseDto?> GetAsync(Guid userId, CancellationToken cancellationToken = default);

    Task SetAsync(Guid userId, DailySummaryResponseDto response, CancellationToken cancellationToken = default);
}
