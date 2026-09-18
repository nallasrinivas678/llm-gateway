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

    private class FakeProvider : ILlmProvider
    {
        private readonly bool _shouldThrow;

        public FakeProvider(string name, int priority, bool shouldThrow)
        {
            Name = name;
            Priority = priority;
            _shouldThrow = shouldThrow;
        }

        public string Name { get; }
        public int Priority { get; }

        public Task<ChatCompletionResponse> CompleteAsync(ChatCompletionRequest request, CancellationToken cancellationToken = default)
        {
            if (_shouldThrow)
            {
                throw new HttpRequestException("simulated failure");
            }

            return Task.FromResult(new ChatCompletionResponse { Provider = Name, Model = request.Model });
        }
    }
}
