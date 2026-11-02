using LlmGateway.Assistant.Connectors;

namespace LlmGateway.Assistant.Tests.Fakes;

public class FakeGmailConnector : IGmailConnector
{
    private readonly List<GmailMessageSummary> _messages;

    public List<Guid> ReceivedUserIds { get; } = new();

    public FakeGmailConnector(List<GmailMessageSummary>? messages = null)
    {
        _messages = messages ?? new List<GmailMessageSummary>();
    }

    public Task SendEmailAsync(Guid userId, string to, string subject, string body, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException();

    public Task<List<GmailMessageSummary>> SearchImportantMessagesAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        ReceivedUserIds.Add(userId);
        return Task.FromResult(_messages);
    }
}
