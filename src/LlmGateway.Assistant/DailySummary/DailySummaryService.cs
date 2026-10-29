using System.Text;
using LlmGateway.Assistant.Connectors;
using LlmGateway.Assistant.Models;
using LlmGateway.Assistant.Providers;
using Microsoft.Extensions.Options;

namespace LlmGateway.Assistant.DailySummary;

// Builds the GET /assistant/daily-summary response: fetches Gmail (orders/bills/travel) and
// Calendar data concurrently, then makes a single non-tool-calling ILlmProvider call to turn it
// into a short written summary. Deliberately bypasses ChatOrchestrator/ToolRegistry - there's no
// need for the model to decide to call tools turn-by-turn here, the data is already fetched.
public class DailySummaryService
{
    private const string SystemPrompt =
        "You are a daily briefing assistant. Given a user's recent important emails " +
        "(orders/purchases, bills/payments due, travel/bookings) and upcoming calendar events, " +
        "write a short, friendly daily summary. Group emails by category, and call out anything " +
        "time-sensitive (a bill due soon, upcoming travel, an event starting soon). Keep it concise.";

    private readonly IGmailConnector _gmailConnector;
    private readonly ICalendarConnector _calendarConnector;
    private readonly ILlmProvider _llmProvider;
    private readonly DailySummaryOptions _options;

    public DailySummaryService(
        IGmailConnector gmailConnector,
        ICalendarConnector calendarConnector,
        ILlmProvider llmProvider,
        IOptions<DailySummaryOptions> options)
    {
        _gmailConnector = gmailConnector;
        _calendarConnector = calendarConnector;
        _llmProvider = llmProvider;
        _options = options.Value;
    }

    public async Task<DailySummaryResponseDto> BuildAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var emailsTask = _gmailConnector.SearchImportantMessagesAsync(userId, cancellationToken);
        var eventsTask = _calendarConnector.ListUpcomingEventsAsync(userId, _options.MaxCalendarEvents, cancellationToken);
        await Task.WhenAll(emailsTask, eventsTask);

        var emails = emailsTask.Result;
        var events = eventsTask.Result;

        var request = new ChatRequest
        {
            SystemPrompt = SystemPrompt,
            Tools = new List<ToolSchema>(),
            Messages = new List<ChatMessage>
            {
                new() { Role = "user", Content = BuildPrompt(emails, events) }
            }
        };

        var response = await CompleteWithTimeoutAndRetryAsync(request, cancellationToken);

        return new DailySummaryResponseDto(
            response.Content,
            emails.Select(e => new EmailHighlightDto(e.Category, e.Subject, e.From, e.Date)).ToList(),
            events.Select(e => new CalendarHighlightDto(e.Summary, e.Start, e.End)).ToList(),
            DateTimeOffset.UtcNow);
    }

    private static string BuildPrompt(List<GmailMessageSummary> emails, List<CalendarEvent> events)
    {
        var builder = new StringBuilder();

        builder.AppendLine("Important emails:");
        if (emails.Count == 0)
        {
            builder.AppendLine("(none found)");
        }
        else
        {
            foreach (var email in emails)
            {
                builder.AppendLine($"- [{email.Category}] \"{email.Subject}\" from {email.From} on {email.Date:yyyy-MM-dd} - {email.Snippet}");
            }
        }

        builder.AppendLine();
        builder.AppendLine("Upcoming calendar events:");
        if (events.Count == 0)
        {
            builder.AppendLine("(none found)");
        }
        else
        {
            foreach (var calendarEvent in events)
            {
                builder.AppendLine($"- \"{calendarEvent.Summary}\" from {calendarEvent.Start:yyyy-MM-dd HH:mm} to {calendarEvent.End:yyyy-MM-dd HH:mm}");
            }
        }

        return builder.ToString();
    }

    private async Task<ChatResponse> CompleteWithTimeoutAndRetryAsync(ChatRequest request, CancellationToken cancellationToken)
    {
        Exception? lastException = null;

        for (var attempt = 0; attempt <= _options.LlmMaxRetries; attempt++)
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(_options.LlmTimeoutSeconds));

            try
            {
                return await _llmProvider.CompleteAsync(request, timeoutCts.Token);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
            {
                lastException = ex;
            }
        }

        throw new InvalidOperationException("Failed to generate the daily summary after retrying the LLM call.", lastException);
    }
}
