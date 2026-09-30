using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.Providers;

// Distinct from LlmGateway.Api's ILlmProvider: this one is tool-calling aware (ChatRequest
// carries Tools; ChatResponse can carry ToolCalls instead of a final answer), which none of the
// gateway's OpenAI-compatible providers currently model. Anthropic/Gemini are used here directly
// rather than proxied through the existing gateway because tool-calling round-trips need
// provider-native request/response shapes the gateway's ChatCompletionRequest/Response don't
// carry (see ARCHITECTURE.md's caching section for why the gateway's contract stays generic).
public interface ILlmProvider
{
    Task<ChatResponse> CompleteAsync(ChatRequest request, CancellationToken cancellationToken = default);
}
