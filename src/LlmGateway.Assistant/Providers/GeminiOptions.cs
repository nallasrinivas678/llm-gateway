namespace LlmGateway.Assistant.Providers;

public class GeminiOptions
{
    public string Endpoint { get; set; } = "https://generativelanguage.googleapis.com";
    public string ApiKey { get; set; } = string.Empty;
    public string Model { get; set; } = "gemini-2.5-flash";
}
