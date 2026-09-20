using LlmGateway.Api.Models;

namespace LlmGateway.Api.Caching;

public interface ICacheStore
{
    Task<ChatCompletionResponse?> GetAsync(string key, CancellationToken cancellationToken = default);
    Task SetAsync(string key, ChatCompletionResponse response, TimeSpan ttl, CancellationToken cancellationToken = default);
}
