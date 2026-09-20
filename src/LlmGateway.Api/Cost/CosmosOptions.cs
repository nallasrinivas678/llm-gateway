namespace LlmGateway.Api.Cost;

public class CosmosOptions
{
    public bool RequestLoggingEnabled { get; set; } = true;
    public string CosmosConnectionString { get; set; } = string.Empty;
    public string DatabaseName { get; set; } = "LlmGateway";
    public string ContainerName { get; set; } = "RequestLogs";
    public string PartitionKeyPath { get; set; } = "/CallerId";
}
