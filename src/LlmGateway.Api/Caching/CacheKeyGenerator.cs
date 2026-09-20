using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LlmGateway.Api.Models;

namespace LlmGateway.Api.Caching;

// hash(prompt, model, params), scoped to Model/Messages/Temperature only - deliberately excludes
// CallerId, since two different callers asking the identical deterministic question should share
// a cache entry.
public static class CacheKeyGenerator
{
    public static string Generate(ChatCompletionRequest request)
    {
        var canonical = JsonSerializer.Serialize(new
        {
            request.Model,
            request.Temperature,
            Messages = request.Messages.Select(m => new { m.Role, m.Content })
        });

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexString(hash);
    }
}
