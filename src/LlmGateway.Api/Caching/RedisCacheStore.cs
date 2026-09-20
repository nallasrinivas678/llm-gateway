using System.Text.Json;
using LlmGateway.Api.Models;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace LlmGateway.Api.Caching;

public class RedisCacheStore : ICacheStore
{
    private const string KeyPrefix = "llm-gateway:chat:";

    private readonly IConnectionMultiplexer _redis;
    private readonly ILogger<RedisCacheStore> _logger;

    public RedisCacheStore(IConnectionMultiplexer redis, ILogger<RedisCacheStore> logger)
    {
        _redis = redis;
        _logger = logger;
    }

    // Cache is a performance optimization, not a hard dependency - a Redis outage should degrade
    // to "no caching" rather than break chat completions, so failures here are swallowed and logged.
    public async Task<ChatCompletionResponse?> GetAsync(string key, CancellationToken cancellationToken = default)
    {
        try
        {
            var db = _redis.GetDatabase();
            var value = await db.StringGetAsync(BuildKey(key));
            return value.IsNullOrEmpty ? null : JsonSerializer.Deserialize<ChatCompletionResponse>(value!);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Cache lookup failed for key {Key}; treating as a cache miss.", key);
            return null;
        }
    }

    public async Task SetAsync(string key, ChatCompletionResponse response, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        try
        {
            var db = _redis.GetDatabase();
            await db.StringSetAsync(BuildKey(key), JsonSerializer.Serialize(response), ttl);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Cache write failed for key {Key}; continuing without caching this response.", key);
        }
    }

    private static string BuildKey(string key) => KeyPrefix + key;
}
