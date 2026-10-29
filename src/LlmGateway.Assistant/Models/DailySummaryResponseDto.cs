namespace LlmGateway.Assistant.Models;

public record DailySummaryResponseDto(
    string Summary,
    List<EmailHighlightDto> Emails,
    List<CalendarHighlightDto> Events,
    DateTimeOffset GeneratedAtUtc);

public record EmailHighlightDto(string Category, string Subject, string From, DateTimeOffset Date);

public record CalendarHighlightDto(string Summary, DateTimeOffset Start, DateTimeOffset End);
