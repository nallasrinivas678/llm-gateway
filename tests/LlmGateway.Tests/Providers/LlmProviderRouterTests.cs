using LlmGateway.Api.Models;
using LlmGateway.Api.Providers;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace LlmGateway.Tests.Providers;

public class LlmProviderRouterTests
{
    [Fact]
    public async Task CompleteAsync_FallsBackToSecondProvider_WhenPrimaryThrows()
    {
        var primary = new FakeProvider("primary", priority: 0, shouldThrow: true);
        var fallback = new FakeProvider("fallback", priority: 1, shouldThrow: false);
        var router = new LlmProviderRouter(new ILlmProvider[] { fallback, primary }, NullLogger<LlmProviderRouter>.Instance);

        var response = await router.CompleteAsync(new ChatCompletionRequest { Model = "gpt-4o-mini", CallerId = "test" });

        Assert.Equal("fallback", response.Provider);
    }

    [Fact]
    public async Task CompleteAsync_ThrowsAllProvidersFailedException_WhenEveryProviderThrows()
    {
        var primary = new FakeProvider("primary", priority: 0, shouldThrow: true);
        var fallback = new FakeProvider("fallback", priority: 1, shouldThrow: true);
        var router = new LlmProviderRouter(new ILlmProvider[] { primary, fallback }, NullLogger<LlmProviderRouter>.Instance);

        await Assert.ThrowsAsync<AllProvidersFailedException>(() =>
            router.CompleteAsync(new ChatCompletionRequest { Model = "gpt-4o-mini", CallerId = "test" }));
    }

    [Fact]
    public async Task CompleteAsync_FallsBackOnTaskCanceledException_WhenNotCallerInitiated()
    {
        // Simulates a provider hanging past HttpClient's own timeout backstop (a TaskCanceledException
        // unrelated to Polly's TimeoutRejectedException) rather than the caller cancelling the request.
        var primary = new FakeProvider("primary", priority: 0, exceptionToThrow: new TaskCanceledException("simulated HttpClient.Timeout"));
        var fallback = new FakeProvider("fallback", priority: 1, shouldThrow: false);
        var router = new LlmProviderRouter(new ILlmProvider[] { primary, fallback }, NullLogger<LlmProviderRouter>.Instance);

        var response = await router.CompleteAsync(new ChatCompletionRequest { Model = "gpt-4o-mini", CallerId = "test" });

        Assert.Equal("fallback", response.Provider);
    }

    [Fact]
    public async Task CompleteAsync_PropagatesImmediately_WhenCallerCancels()
    {
        using var cts = new CancellationTokenSource();
        var primary = new FakeProvider("primary", priority: 0, throwOperationCanceled: cts);
        var fallback = new FakeProvider("fallback", priority: 1, shouldThrow: false);
        var router = new LlmProviderRouter(new ILlmProvider[] { primary, fallback }, NullLogger<LlmProviderRouter>.Instance);

        cts.Cancel();

        await Assert.ThrowsAsync<TaskCanceledException>(() =>
            router.CompleteAsync(new ChatCompletionRequest { Model = "gpt-4o-mini", CallerId = "test" }, cts.Token));
    }

    private class FakeProvider : ILlmProvider
    {
        private readonly bool _shouldThrow;
        private readonly Exception? _exceptionToThrow;
        private readonly CancellationTokenSource? _throwOperationCanceled;

        public FakeProvider(string name, int priority, bool shouldThrow = false, Exception? exceptionToThrow = null, CancellationTokenSource? throwOperationCanceled = null)
        {
            Name = name;
            Priority = priority;
            _shouldThrow = shouldThrow;
            _exceptionToThrow = exceptionToThrow;
            _throwOperationCanceled = throwOperationCanceled;
        }

        public string Name { get; }
        public int Priority { get; }

        public Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
        {
            if (_throwOperationCanceled is not null)
            {
                throw new TaskCanceledException("caller canceled", null, _throwOperationCanceled.Token);
            }

            if (_exceptionToThrow is not null)
            {
                throw _exceptionToThrow;
            }

            if (_shouldThrow)
            {
                throw new HttpRequestException("simulated failure");
            }

            return Task.FromResult(new ChatCompletionResponse { Provider = Name, Model = request.Model });
        }
    }
}
