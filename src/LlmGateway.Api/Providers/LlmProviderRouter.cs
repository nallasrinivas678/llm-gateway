using LlmGateway.Api.Models;
using Microsoft.Extensions.Logging;
using Polly.CircuitBreaker;
using Polly.Timeout;

namespace LlmGateway.Api.Providers;

// Tries providers in priority order, falling back to the next one when a provider's
// resilience pipeline gives up (retries exhausted, circuit open, or per-attempt timeout).
public class LlmProviderRouter
{
    private readonly List<ILlmProvider> _providers;
    private readonly ILogger<LlmProviderRouter> _logger;

    public LlmProviderRouter(IEnumerable<ILlmProvider> providers, ILogger<LlmProviderRouter> logger)
    {
        _providers = providers.OrderBy(p => p.Priority).ToList();
        _logger = logger;

        if (_providers.Count == 0)
        {
            throw new InvalidOperationException("No ILlmProvider implementations are registered.");
        }
    }

    public async Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
    {
        Exception? lastException = null;

        for (var i = 0; i < _providers.Count; i++)
        {
            var provider = _providers[i];
            try
            {
                return await provider.CompleteAsync(request, cancellationToken);
            }
            catch (Exception ex) when (ex is BrokenCircuitException or HttpRequestException or TimeoutRejectedException)
            {
                lastException = ex;
                var remaining = _providers.Count - i - 1;
                _logger.LogWarning(ex, "Provider {Provider} failed, {Remaining} fallback(s) remaining.", provider.Name, remaining);
            }
        }

        throw new AllProvidersFailedException("All configured LLM providers failed.", lastException);
    }
}

public class AllProvidersFailedException : Exception
{
    public AllProvidersFailedException(string message, Exception? innerException)
        : base(message, innerException)
    {
    }
}
