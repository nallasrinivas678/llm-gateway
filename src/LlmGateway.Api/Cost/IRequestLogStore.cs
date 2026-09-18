namespace LlmGateway.Api.Cost;

public interface IRequestLogStore
{
    Task InitializeAsync(CancellationToken cancellationToken = default);
    Task LogAsync(RequestLogEntry entry, CancellationToken cancellationToken = default);
    Task<UsageSummary> GetUsageAsync(string callerId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken = default);
}
