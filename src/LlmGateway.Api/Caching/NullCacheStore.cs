using LlmGateway.Api.Models;

namespace LlmGateway.Api.Caching;

// Used when Cache:Enabled is false. Every lookup misses and every write is a no-op, so the
// gateway runs correctly (just without caching) when Redis isn't configured/reachable.
public class NullCacheStore : ICacheStore
{
    public Task<ChatCompletionResponse?> GetAsync(string key, CancellationToken cancellationToken = default) =>
        Task.FromResult<ChatCompletionResponse?>(null);

    public Task SetAsync(string key, ChatCompletionResponse response, TimeSpan ttl, CancellationToken cancellationToken = default) =>
        Task.CompletedTask;
}
