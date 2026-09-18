using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;

namespace LlmGateway.Api.Cost;

public class CosmosRequestLogStore : IRequestLogStore
{
    private readonly CosmosClient _client;
    private readonly CosmosOptions _options;
    private Container? _container;

    public CosmosRequestLogStore(CosmosClient client, IOptions<CosmosOptions> options)
    {
        _client = client;
        _options = options.Value;
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        var database = await _client.CreateDatabaseIfNotExistsAsync(_options.DatabaseName, cancellationToken: cancellationToken);
        var containerResponse = await database.Database.CreateContainerIfNotExistsAsync(
            _options.ContainerName, _options.PartitionKeyPath, cancellationToken: cancellationToken);
        _container = containerResponse.Container;
    }

    public async Task LogAsync(RequestLogEntry entry, CancellationToken cancellationToken = default)
    {
        var container = GetContainer();
        await container.CreateItemAsync(entry, new PartitionKey(entry.CallerId), cancellationToken: cancellationToken);
    }

    public async Task<UsageSummary> GetUsageAsync(string callerId, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken = default)
    {
        var container = GetContainer();
        var query = new QueryDefinition(
                "SELECT * FROM c WHERE c.CallerId = @callerId AND c.TimestampUtc >= @from AND c.TimestampUtc <= @to")
            .WithParameter("@callerId", callerId)
            .WithParameter("@from", from)
            .WithParameter("@to", to);

        var summary = new UsageSummary { CallerId = callerId, From = from, To = to };

        using var iterator = container.GetItemQueryIterator<RequestLogEntry>(
            query,
            requestOptions: new QueryRequestOptions { PartitionKey = new PartitionKey(callerId) });

        while (iterator.HasMoreResults)
        {
            var page = await iterator.ReadNextAsync(cancellationToken);
            foreach (var entry in page)
            {
                summary.TotalRequests++;
                summary.TotalPromptTokens += entry.PromptTokens;
                summary.TotalCompletionTokens += entry.CompletionTokens;
                summary.TotalTokens += entry.TotalTokens;
                summary.TotalCostUsd += entry.CostUsd;
            }
        }

        return summary;
    }

    private Container GetContainer() =>
        _container ?? throw new InvalidOperationException("Request log store has not been initialized. Call InitializeAsync at startup.");
}
