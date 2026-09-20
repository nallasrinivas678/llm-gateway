namespace LlmGateway.Api.Providers;

public class AzureOpenAiOptions
{
    public string Endpoint { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public string ApiVersion { get; set; } = "2024-02-15-preview";
    public int Priority { get; set; } = 1;
}
