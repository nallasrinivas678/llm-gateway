namespace LlmGateway.Api.Providers;

public class OllamaOptions
{
    public string Endpoint { get; set; } = "http://localhost:11434";

    // Ollama fallback always uses this locally-pulled model, regardless of what the caller
    // requested - Azure OpenAI/OpenAI model names (e.g. "gpt-4o-mini") don't exist locally.
    public string Model { get; set; } = "llama3.2";

    // Default primary: the only provider that works out of the box with no cloud credentials
    // configured. Set this higher than Azure OpenAI/OpenAI's Priority once real keys are added,
    // so cloud providers are tried first and Ollama becomes the fallback again.
    public int Priority { get; set; } = 0;
}
