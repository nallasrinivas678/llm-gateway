using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using LlmGateway.Assistant.DailySummary;
using Microsoft.Extensions.Options;

namespace LlmGateway.Assistant.Connectors;

public class GmailMessageSummary
{
    public string Id { get; set; } = string.Empty;
    public string Subject { get; set; } = string.Empty;
    public string From { get; set; } = string.Empty;
    public string Snippet { get; set; } = string.Empty;
    public DateTimeOffset Date { get; set; }
    public string Category { get; set; } = string.Empty;
}

public interface IGmailConnector
{
    Task SendEmailAsync(Guid userId, string to, string subject, string body, CancellationToken cancellationToken = default);

    // Daily-summary feature: searches for the three categories the summary cares about
    // (orders/purchases, bills/payments due, travel/bookings) via Gmail's own search operators -
    // no message-body parsing, no amount/order-number extraction.
    Task<List<GmailMessageSummary>> SearchImportantMessagesAsync(Guid userId, CancellationToken cancellationToken = default);
}

// STUB (SendEmailAsync only) - build order step 9 ("Gmail, Docs connectors - added incrementally,
// same OAuth service"). SendEmailAsync still needs wiring up the same way CalendarConnector is:
// IGoogleOAuthService.GetValidAccessTokenAsync for the token, then POST to
// https://gmail.googleapis.com/gmail/v1/users/me/messages/send with a base64url-encoded RFC 2822
// MIME message as the `raw` field.
public class GmailConnector : IGmailConnector
{
    private const string MessagesEndpoint = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

    private static readonly List<(string Category, string Query)> ImportantMessageQueries = new()
    {
        ("order", "category:purchases OR subject:(order OR receipt OR shipped OR delivery OR invoice) newer_than:14d"),
        ("bill", "subject:(bill OR \"payment due\" OR autopay OR statement OR \"amount due\") newer_than:14d"),
        ("travel", "subject:(itinerary OR booking OR reservation OR flight OR \"boarding pass\" OR confirmation) OR from:(booking.com OR airbnb OR expedia) newer_than:30d")
    };

    private readonly HttpClient _httpClient;
    private readonly IGoogleOAuthService _oauthService;
    private readonly DailySummaryOptions _options;

    public GmailConnector(HttpClient httpClient, IGoogleOAuthService oauthService, IOptions<DailySummaryOptions> options)
    {
        _httpClient = httpClient;
        _oauthService = oauthService;
        _options = options.Value;
    }

    public Task SendEmailAsync(Guid userId, string to, string subject, string body, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("GmailConnector.SendEmailAsync - see docs/plan.md build order step 9.");

    public async Task<List<GmailMessageSummary>> SearchImportantMessagesAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var accessToken = await _oauthService.GetValidAccessTokenAsync(userId, cancellationToken);

        var results = new List<GmailMessageSummary>();
        var seenIds = new HashSet<string>();

        foreach (var (category, query) in ImportantMessageQueries)
        {
            var messageIds = await ListMessageIdsAsync(query, accessToken, cancellationToken);

            foreach (var messageId in messageIds.Take(_options.MaxEmailsPerCategory))
            {
                if (!seenIds.Add(messageId))
                {
                    continue; // already matched by an earlier category's query
                }

                var summary = await GetMessageSummaryAsync(messageId, category, accessToken, cancellationToken);
                if (summary is not null)
                {
                    results.Add(summary);
                }

                if (results.Count >= _options.MaxTotalEmails)
                {
                    return results;
                }
            }
        }

        return results;
    }

    private async Task<List<string>> ListMessageIdsAsync(string query, string accessToken, CancellationToken cancellationToken)
    {
        var uri = $"{MessagesEndpoint}?q={Uri.EscapeDataString(query)}&maxResults={_options.MaxEmailsPerCategory}";

        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        var body = await response.Content.ReadFromJsonAsync<GmailMessageListResponse>(cancellationToken: cancellationToken);
        return body?.Messages?.Select(m => m.Id).Where(id => id is not null).Select(id => id!).ToList() ?? new List<string>();
    }

    private async Task<GmailMessageSummary?> GetMessageSummaryAsync(string messageId, string category, string accessToken, CancellationToken cancellationToken)
    {
        var uri = $"{MessagesEndpoint}/{messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date";

        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        var body = await response.Content.ReadFromJsonAsync<GmailMessageGetResponse>(cancellationToken: cancellationToken);
        if (body is null)
        {
            return null;
        }

        var headers = body.Payload?.Headers ?? new();
        string Header(string name) =>
            headers.FirstOrDefault(h => string.Equals(h.Name, name, StringComparison.OrdinalIgnoreCase))?.Value ?? string.Empty;

        return new GmailMessageSummary
        {
            Id = body.Id ?? messageId,
            Subject = Header("Subject"),
            From = Header("From"),
            Snippet = body.Snippet ?? string.Empty,
            Date = DateTimeOffset.TryParse(Header("Date"), out var parsedDate) ? parsedDate : DateTimeOffset.UtcNow,
            Category = category
        };
    }

    private class GmailMessageListResponse
    {
        [JsonPropertyName("messages")]
        public List<GmailMessageId>? Messages { get; set; }
    }

    private class GmailMessageId
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }
    }

    private class GmailMessageGetResponse
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("snippet")]
        public string? Snippet { get; set; }

        [JsonPropertyName("payload")]
        public GmailMessagePayload? Payload { get; set; }
    }

    private class GmailMessagePayload
    {
        [JsonPropertyName("headers")]
        public List<GmailMessageHeader>? Headers { get; set; }
    }

    private class GmailMessageHeader
    {
        [JsonPropertyName("name")]
        public string? Name { get; set; }

        [JsonPropertyName("value")]
        public string? Value { get; set; }
    }
}
