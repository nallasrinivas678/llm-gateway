using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Web;
using Microsoft.Extensions.Options;
using Npgsql;

namespace LlmGateway.Assistant.Connectors;

// Real Google OAuth2 authorization-code + refresh-token flow against Google's stable, documented
// token endpoint. Persists into the `google_tokens` table exactly as defined in docs/plan.md
// section 1.
//
// TODO (see plan.md's note on google_tokens): access_token/refresh_token are stored as-is here.
// Encrypt at the application layer (or move to Supabase Vault) before this goes anywhere near
// production - that decision depends on the Key Vault setup from the AKS deployment plan (section
// 4), which isn't provisioned yet.
public class GoogleOAuthService : IGoogleOAuthService
{
    private const string TokenEndpoint = "https://oauth2.googleapis.com/token";
    private const string AuthorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";

    private readonly HttpClient _httpClient;
    private readonly NpgsqlDataSource _dataSource;
    private readonly GoogleOAuthOptions _options;

    public GoogleOAuthService(HttpClient httpClient, NpgsqlDataSource dataSource, IOptions<GoogleOAuthOptions> options)
    {
        _httpClient = httpClient;
        _dataSource = dataSource;
        _options = options.Value;
    }

    public string BuildAuthorizationUrl(Guid userId)
    {
        var query = HttpUtility.ParseQueryString(string.Empty);
        query["client_id"] = _options.ClientId;
        query["redirect_uri"] = _options.RedirectUri;
        query["response_type"] = "code";
        query["access_type"] = "offline";
        query["prompt"] = "consent";
        query["scope"] = _options.Scopes;
        query["state"] = userId.ToString();

        return $"{AuthorizationEndpoint}?{query}";
    }

    public async Task ExchangeCodeAsync(Guid userId, string authorizationCode, CancellationToken cancellationToken = default)
    {
        var form = new Dictionary<string, string>
        {
            ["code"] = authorizationCode,
            ["client_id"] = _options.ClientId,
            ["client_secret"] = _options.ClientSecret,
            ["redirect_uri"] = _options.RedirectUri,
            ["grant_type"] = "authorization_code"
        };

        var tokenResponse = await PostTokenRequestAsync(form, cancellationToken);

        await UpsertTokensAsync(
            userId,
            tokenResponse.AccessToken,
            tokenResponse.RefreshToken ?? throw new InvalidOperationException("Google did not return a refresh_token - was access_type=offline and prompt=consent sent on the authorization request?"),
            tokenResponse.ExpiresIn,
            cancellationToken);
    }

    public async Task<string> GetValidAccessTokenAsync(Guid userId, CancellationToken cancellationToken = default)
    {
        var (accessToken, refreshToken, expiresAt) = await ReadTokensAsync(userId, cancellationToken)
            ?? throw new InvalidOperationException($"No Google tokens on file for user {userId}. They need to complete the OAuth flow first.");

        if (expiresAt > DateTimeOffset.UtcNow.AddMinutes(1))
        {
            return accessToken;
        }

        var form = new Dictionary<string, string>
        {
            ["refresh_token"] = refreshToken,
            ["client_id"] = _options.ClientId,
            ["client_secret"] = _options.ClientSecret,
            ["grant_type"] = "refresh_token"
        };

        var tokenResponse = await PostTokenRequestAsync(form, cancellationToken);

        // A refresh grant doesn't always return a new refresh_token - keep the existing one when absent.
        await UpsertTokensAsync(userId, tokenResponse.AccessToken, tokenResponse.RefreshToken ?? refreshToken, tokenResponse.ExpiresIn, cancellationToken);

        return tokenResponse.AccessToken;
    }

    private async Task<GoogleTokenResponse> PostTokenRequestAsync(Dictionary<string, string> form, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsync(TokenEndpoint, new FormUrlEncodedContent(form), cancellationToken);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<GoogleTokenResponse>(cancellationToken: cancellationToken)
            ?? throw new InvalidOperationException("Google's token endpoint returned an empty response.");
    }

    private async Task<(string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt)?> ReadTokensAsync(Guid userId, CancellationToken cancellationToken)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT access_token, refresh_token, expires_at FROM google_tokens WHERE user_id = $1";
        command.Parameters.AddWithValue(userId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            return null;
        }

        return (reader.GetString(0), reader.GetString(1), reader.GetFieldValue<DateTimeOffset>(2));
    }

    private async Task UpsertTokensAsync(Guid userId, string accessToken, string refreshToken, int expiresInSeconds, CancellationToken cancellationToken)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO google_tokens (user_id, access_token, refresh_token, scopes, expires_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, now())
            ON CONFLICT (user_id) DO UPDATE SET
                access_token = excluded.access_token,
                refresh_token = excluded.refresh_token,
                scopes = excluded.scopes,
                expires_at = excluded.expires_at,
                updated_at = now()
            """;
        command.Parameters.AddWithValue(userId);
        command.Parameters.AddWithValue(accessToken);
        command.Parameters.AddWithValue(refreshToken);
        command.Parameters.AddWithValue(_options.Scopes);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.AddSeconds(expiresInSeconds));

        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private class GoogleTokenResponse
    {
        [JsonPropertyName("access_token")]
        public string AccessToken { get; set; } = string.Empty;

        [JsonPropertyName("refresh_token")]
        public string? RefreshToken { get; set; }

        [JsonPropertyName("expires_in")]
        public int ExpiresIn { get; set; }
    }
}
