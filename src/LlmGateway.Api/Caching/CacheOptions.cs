namespace LlmGateway.Api.Caching;

public class CacheOptions
{
    public bool Enabled { get; set; } = true;
    public string RedisConnectionString { get; set; } = "localhost:6379";
    public int DefaultTtlSeconds { get; set; } = 300;
}
