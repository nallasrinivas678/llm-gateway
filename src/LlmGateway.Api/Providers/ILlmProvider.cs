using LlmGateway.Api.Models;

namespace LlmGateway.Api.Providers;

public interface ILlmProvider
{
    string Name { get; }

    // Lower runs first. Used to order the fallback chain in LlmProviderRouter.
    int Priority { get; }

    Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default);
}
