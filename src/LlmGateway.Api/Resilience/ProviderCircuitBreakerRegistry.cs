using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using Polly.CircuitBreaker;

namespace LlmGateway.Api.Resilience;

// Holds one circuit breaker instance per provider name for the app's lifetime. Policies must be
// built once and reused (not recreated per HttpClientFactory pipeline rebuild), otherwise the
// breaker's open/closed state would reset every time the pipeline rotates.
public class ProviderCircuitBreakerRegistry
{
    private readonly ConcurrentDictionary<string, AsyncCircuitBreakerPolicy<HttpResponseMessage>> _breakers = new();
    private readonly ResilienceOptions _options;

    public ProviderCircuitBreakerRegistry(IOptions<ResilienceOptions> options)
    {
        _options = options.Value;
    }

    public AsyncCircuitBreakerPolicy<HttpResponseMessage> GetOrCreate(string providerName) =>
        _breakers.GetOrAdd(providerName, _ => ResiliencePolicies.GetCircuitBreakerPolicy(_options));

    public IReadOnlyDictionary<string, string> GetAllStates() =>
        _breakers.ToDictionary(kv => kv.Key, kv => kv.Value.CircuitState.ToString());
}
