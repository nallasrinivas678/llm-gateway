using LlmGateway.Assistant.Connectors;

namespace LlmGateway.Assistant.Tests.Fakes;

public class FakeCalendarConnector : ICalendarConnector
{
    private readonly List<CalendarEvent> _events;

    public FakeCalendarConnector(List<CalendarEvent>? events = null)
    {
        _events = events ?? new List<CalendarEvent>();
    }

    public Task<List<CalendarEvent>> ListUpcomingEventsAsync(Guid userId, int maxResults = 10, CancellationToken cancellationToken = default) =>
        Task.FromResult(_events);

    public Task<CalendarEvent> CreateEventAsync(Guid userId, CalendarEvent calendarEvent, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException();
}
