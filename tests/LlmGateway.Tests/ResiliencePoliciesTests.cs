using System.Net;
using LlmGateway.Api.Resilience;
using Polly.CircuitBreaker;
using Polly.Timeout;
using Xunit;

namespace LlmGateway.Tests;

public class ResiliencePoliciesTests
{
    [Fact]
    public async Task RetryPolicy_RetriesConfiguredNumberOfTimesOnServerError()
    {
        var options = new ResilienceOptions { RetryCount = 2, TimeoutSeconds = 5 };
        var policy = ResiliencePolicies.GetRetryPolicy(options);
        var attempts = 0;

        var result = await policy.ExecuteAsync(() =>
        {
            attempts++;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError));
        });

        Assert.Equal(3, attempts); // initial attempt + 2 retries
        Assert.Equal(HttpStatusCode.InternalServerError, result.StatusCode);
    }

    [Fact]
    public async Task TimeoutPolicy_ThrowsWhenOperationExceedsTimeout()
    {
        var options = new ResilienceOptions { RetryCount = 0, TimeoutSeconds = 1 };
        var policy = ResiliencePolicies.GetTimeoutPolicy(options);

        await Assert.ThrowsAsync<TimeoutRejectedException>(() =>
            policy.ExecuteAsync(async ct =>
            {
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
                return new HttpResponseMessage();
            }, CancellationToken.None));
    }

    [Fact]
    public async Task CircuitBreakerPolicy_OpensAfterThresholdConsecutiveFailures()
    {
        var options = new ResilienceOptions { CircuitBreakerThreshold = 2, CircuitBreakerDurationSeconds = 30 };
        var policy = ResiliencePolicies.GetCircuitBreakerPolicy(options);

        for (var i = 0; i < options.CircuitBreakerThreshold; i++)
        {
            await Assert.ThrowsAsync<HttpRequestException>(() =>
                policy.ExecuteAsync(() => throw new HttpRequestException("simulated failure")));
        }

        Assert.Equal(CircuitState.Open, policy.CircuitState);

        // Once open, calls should fail fast with BrokenCircuitException instead of reaching the action.
        await Assert.ThrowsAsync<BrokenCircuitException>(() =>
            policy.ExecuteAsync(() => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK))));
    }
}
