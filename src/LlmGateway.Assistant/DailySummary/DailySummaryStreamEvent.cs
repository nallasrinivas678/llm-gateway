using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.DailySummary;

// The events DailySummaryService.StreamAsync yields, written to the client one-for-one as SSE
// frames (see DailySummaryController's /stream endpoint).
public abstract record DailySummaryStreamEvent
{
    public sealed record Status(string Message) : DailySummaryStreamEvent;

    public sealed record Chunk(string Text) : DailySummaryStreamEvent;

    public sealed record Done(DailySummaryResponseDto Result) : DailySummaryStreamEvent;
}
