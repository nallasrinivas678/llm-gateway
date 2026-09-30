using System.Text.Json;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Connectors;

namespace LlmGateway.Assistant.Tools;

public class ListUpcomingEventsTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": {
            "maxResults": { "type": "integer", "description": "Max events to return (default 10)" }
          }
        }
        """).RootElement;

    private readonly ICalendarConnector _calendar;
    private readonly CurrentUserContext _currentUser;

    public ListUpcomingEventsTool(ICalendarConnector calendar, CurrentUserContext currentUser)
    {
        _calendar = calendar;
        _currentUser = currentUser;
    }

    public string Name => "list_upcoming_calendar_events";
    public string Description => "Lists the user's upcoming Google Calendar events, soonest first.";
    public JsonElement ParametersSchema => Schema;

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        var args = JsonDocument.Parse(argumentsJson).RootElement;
        var maxResults = args.TryGetProperty("maxResults", out var maxResultsProp) ? maxResultsProp.GetInt32() : 10;

        var events = await _calendar.ListUpcomingEventsAsync(_currentUser.UserId, maxResults, cancellationToken);
        return JsonSerializer.Serialize(events);
    }
}

public class CreateCalendarEventTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": {
            "summary": { "type": "string", "description": "Event title" },
            "description": { "type": "string" },
            "start": { "type": "string", "description": "ISO 8601 start time" },
            "end": { "type": "string", "description": "ISO 8601 end time" }
          },
          "required": ["summary", "start", "end"]
        }
        """).RootElement;

    private readonly ICalendarConnector _calendar;
    private readonly CurrentUserContext _currentUser;

    public CreateCalendarEventTool(ICalendarConnector calendar, CurrentUserContext currentUser)
    {
        _calendar = calendar;
        _currentUser = currentUser;
    }

    public string Name => "create_calendar_event";
    public string Description => "Creates a new event on the user's primary Google Calendar.";
    public JsonElement ParametersSchema => Schema;

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        var args = JsonDocument.Parse(argumentsJson).RootElement;

        var newEvent = new CalendarEvent
        {
            Summary = args.GetProperty("summary").GetString() ?? string.Empty,
            Description = args.TryGetProperty("description", out var d) ? d.GetString() : null,
            Start = DateTimeOffset.Parse(args.GetProperty("start").GetString()!),
            End = DateTimeOffset.Parse(args.GetProperty("end").GetString()!)
        };

        var created = await _calendar.CreateEventAsync(_currentUser.UserId, newEvent, cancellationToken);
        return JsonSerializer.Serialize(created);
    }
}
