using Microsoft.IdentityModel.Tokens;

namespace LlmGateway.Assistant.Auth;

// Supabase migrated every project from a shared HS256 secret to per-key asymmetric signing
// (ES256) around October 2025 - real session JWTs now carry a `kid` and can only be verified
// against Supabase's published public keys, not a static secret. This fetches and caches those
// keys from the project's JWKS endpoint (`{issuer}/.well-known/jwks.json`, the path Supabase's
// own docs document) so SupabaseJwtValidator can resolve a signing key per token.
//
// Supabase's docs note their edge cache for this endpoint is 10 minutes; matching that here means
// a rotated key is picked up about as fast as Supabase itself would serve it anyway.
internal class SupabaseJwksKeyResolver
{
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(10);
    private static readonly HttpClient HttpClient = new();

    private readonly string _jwksUri;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private JsonWebKeySet? _cachedKeySet;
    private DateTimeOffset _cachedAt;

    public SupabaseJwksKeyResolver(string issuer)
    {
        _jwksUri = $"{issuer.TrimEnd('/')}/.well-known/jwks.json";
    }

    // Matches TokenValidationParameters.IssuerSigningKeyResolver's delegate shape. Blocking on the
    // async fetch is safe here - ASP.NET Core/Kestrel runs without a SynchronizationContext, so
    // there's no deadlock risk, and the result is cached for CacheDuration so this only actually
    // blocks on a real HTTP call once every 10 minutes.
    public IEnumerable<SecurityKey> ResolveSigningKeys(
        string token, SecurityToken securityToken, string kid, TokenValidationParameters validationParameters)
    {
        var keySet = GetKeySetAsync().GetAwaiter().GetResult();
        return keySet?.Keys ?? Enumerable.Empty<SecurityKey>();
    }

    private async Task<JsonWebKeySet?> GetKeySetAsync()
    {
        if (_cachedKeySet is not null && DateTimeOffset.UtcNow - _cachedAt < CacheDuration)
        {
            return _cachedKeySet;
        }

        await _lock.WaitAsync();
        try
        {
            if (_cachedKeySet is not null && DateTimeOffset.UtcNow - _cachedAt < CacheDuration)
            {
                return _cachedKeySet;
            }

            var json = await HttpClient.GetStringAsync(_jwksUri);
            _cachedKeySet = new JsonWebKeySet(json);
            _cachedAt = DateTimeOffset.UtcNow;
            return _cachedKeySet;
        }
        catch
        {
            // Keep serving the stale cache (if any) rather than failing every request when
            // Supabase's endpoint has a transient blip.
            return _cachedKeySet;
        }
        finally
        {
            _lock.Release();
        }
    }
}
