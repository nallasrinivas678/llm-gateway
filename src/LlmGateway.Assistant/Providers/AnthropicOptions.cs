namespace LlmGateway.Assistant.Providers;

public class AnthropicOptions
{
    public string Endpoint { get; set; } = "https://api.anthropic.com";
    public string ApiKey { get; set; } = string.Empty;
    public string Model { get; set; } = "claude-sonnet-4-5";
    public string AnthropicVersion { get; set; } = "2023-06-01";
    public int MaxTokens { get; set; } = 4096;
}
