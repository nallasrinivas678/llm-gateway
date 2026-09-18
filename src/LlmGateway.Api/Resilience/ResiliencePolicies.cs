using Polly;
using Polly.CircuitBreaker;
using Polly.Timeout;

namespace LlmGateway.Api.Resilience;

public static class ResiliencePolicies
{
    public static IAsyncPolicy<HttpResponseMessage> GetRetryPolicy(ResilienceOptions options)
    {
        var jitter = new Random();

        return Policy<HttpResponseMessage>
            .Handle<HttpRequestException>()
            .Or<TimeoutRejectedException>()
            .OrResult(response => (int)response.StatusCode == 429 || (int)response.StatusCode >= 500)
            .WaitAndRetryAsync(
                options.RetryCount,
                attempt => TimeSpan.FromSeconds(Math.Pow(2, attempt)) + TimeSpan.FromMilliseconds(jitter.Next(0, 250)));
    }

    public static IAsyncPolicy<HttpResponseMessage> GetTimeoutPolicy(ResilienceOptions options) =>
        Policy.TimeoutAsync<HttpResponseMessage>(TimeSpan.FromSeconds(options.TimeoutSeconds), TimeoutStrategy.Optimistic);

    // Deliberately does NOT include BrokenCircuitException in the retry policy's handled exceptions
    // above: once this breaker is open, calls should fail fast (and let LlmProviderRouter fall back
    // to the next provider) instead of burning through the retry budget on a provider that's already down.
    public static AsyncCircuitBreakerPolicy<HttpResponseMessage> GetCircuitBreakerPolicy(ResilienceOptions options) =>
        Policy<HttpResponseMessage>
            .Handle<HttpRequestException>()
            .Or<TimeoutRejectedException>()
            .OrResult(response => (int)response.StatusCode == 429 || (int)response.StatusCode >= 500)
            .CircuitBreakerAsync(
                options.CircuitBreakerThreshold,
                TimeSpan.FromSeconds(options.CircuitBreakerDurationSeconds));
}
