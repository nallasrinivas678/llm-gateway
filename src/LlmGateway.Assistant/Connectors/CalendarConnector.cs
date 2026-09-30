using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace LlmGateway.Assistant.Connectors;

public class CalendarEvent
{
    public string? Id { get; set; }
    public string Summary { get; set; } = string.Empty;
    public string? Description { get; set; }
    public DateTimeOffset Start { get; set; }
    public DateTimeOffset End { get; set; }
}

public interface ICalendarConnector
{
    Task<List<CalendarEvent>> ListUpcomingEventsAsync(Guid userId, int maxResults = 10, CancellationToken cancellationToken = default);
    Task<CalendarEvent> CreateEventAsync(Guid userId, CalendarEvent calendarEvent, CancellationToken cancellationToken = default);
}

// First Google integration per docs/plan.md's build order (step 8) - "simplest surface" of the
// three (Gmail/Calendar/Docs). Talks to Google Calendar API v3's `primary` calendar directly;
// GoogleOAuthService supplies a valid (auto-refreshed) access token per call.
public class CalendarConnector : ICalendarConnector
{
    private const string EventsEndpoint = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

    private readonly HttpClient _httpClient;
    private readonly IGoogleOAuthService _oauthService;

    public CalendarConnector(HttpClient httpClient, IGoogleOAuthService oauthService)
    {
        _httpClient = httpClient;
        _oauthService = oauthService;
    }

    public async Task<List<CalendarEvent>> ListUpcomingEventsAsync(Guid userId, int maxResults = 10, CancellationToken cancellationToken = default)
    {
        var accessToken = await _oauthService.GetValidAccessTokenAsync(userId, cancellationToken);

        var uri = $"{EventsEndpoint}?timeMin={Uri.EscapeDataString(DateTimeOffset.UtcNow.ToString("o"))}" +
                  $"&maxResults={maxResults}&singleEvents=true&orderBy=startTime";

        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<GoogleEventListResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Google Calendar returned an empty response.");

        return body.Items.Select(ToCalendarEvent).ToList();
    }

    public async Task<CalendarEvent> CreateEventAsync(Guid userId, CalendarEvent calendarEvent, CancellationToken cancellationToken = default)
    {
        var accessToken = await _oauthService.GetValidAccessTokenAsync(userId, cancellationToken);

        var payload = new GoogleEvent
        {
            Summary = calendarEvent.Summary,
            Description = calendarEvent.Description,
            Start = new GoogleEventDateTime { DateTime = calendarEvent.Start },
            End = new GoogleEventDateTime { DateTime = calendarEvent.End }
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, EventsEndpoint) { Content = JsonContent.Create(payload) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using var response = await _httpClient.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        var created = await response.Content.ReadFromJsonAsync<GoogleEvent>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Google Calendar returned an empty response.");

        return ToCalendarEvent(created);
    }

    private static CalendarEvent ToCalendarEvent(GoogleEvent googleEvent) => new()
    {
        Id = googleEvent.Id,
        Summary = googleEvent.Summary,
        Description = googleEvent.Description,
        Start = googleEvent.Start.DateTime,
        End = googleEvent.End.DateTime
    };

    private class GoogleEventListResponse
    {
        [JsonPropertyName("items")]
        public List<GoogleEvent> Items { get; set; } = new();
    }

    private class GoogleEvent
    {
        [JsonPropertyName("id")]
        public string? Id { get; set; }

        [JsonPropertyName("summary")]
        public string Summary { get; set; } = string.Empty;

        [JsonPropertyName("description")]
        public string? Description { get; set; }

        [JsonPropertyName("start")]
        public GoogleEventDateTime Start { get; set; } = new();

        [JsonPropertyName("end")]
        public GoogleEventDateTime End { get; set; } = new();
    }

    private class GoogleEventDateTime
    {
        [JsonPropertyName("dateTime")]
        public DateTimeOffset DateTime { get; set; }
    }
}
