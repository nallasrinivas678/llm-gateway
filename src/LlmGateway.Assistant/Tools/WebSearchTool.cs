using System.Text.Json;

namespace LlmGateway.Assistant.Tools;

// STUB - build order step 7: "use provider-native web search/grounding (Anthropic or Gemini)
// first; custom News API only if needed."
//
// Important architectural note: provider-native search (Anthropic's web_search tool type, or
// Gemini's google_search grounding tool) is executed server-side BY THE PROVIDER, not by this
// gateway - it isn't a normal ITool round-trip at all. Wiring that in means adding a special
// built-in-tool declaration to AnthropicProvider/GeminiProvider's request payloads (distinct from
// the user-defined ToolSchema list ChatOrchestrator passes today), not implementing this class.
//
// This ITool implementation is the FALLBACK path only - a custom search API (Bing/Tavily/Brave),
// for cases the provider-native tool doesn't cover. No specific API has been chosen yet, so the
// HTTP call itself isn't implemented - picking the wrong request/response shape blind would be
// worse than leaving this as a clearly-marked gap.
public class WebSearchTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }
        """).RootElement;

    private readonly HttpClient _httpClient;

    public WebSearchTool(HttpClient httpClient)
    {
        _httpClient = httpClient;
    }

    public string Name => "web_search";
    public string Description => "Searches the web for current information not in the model's training data.";
    public JsonElement ParametersSchema => Schema;

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("WebSearchTool - pick a search API (Bing/Tavily/Brave) and implement the call, or prefer provider-native search (see class comment).");
}
