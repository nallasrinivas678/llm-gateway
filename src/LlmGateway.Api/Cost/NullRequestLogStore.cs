namespace LlmGateway.Api.Cost;

// Used when Storage:RequestLoggingEnabled is false. Lets the gateway run (and be tested) without
// a reachable Cosmos DB account/emulator - request logging and usage rollups are simply skipped.
public class NullRequestLogStore : IRequestLogStore
{
    public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task LogAsync(RequestLogEntry entry, CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task<UsageSummary> GetUsageAsync(string callerId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken = default) =>
        Task.FromResult(new UsageSummary { CallerId = callerId, From = from, To = to });
}
