namespace LlmGateway.Api.Providers;

public class OpenAiOptions
{
    public string Endpoint { get; set; } = "https://api.openai.com";
    public string ApiKey { get; set; } = string.Empty;
    public int Priority { get; set; } = 2;
}
