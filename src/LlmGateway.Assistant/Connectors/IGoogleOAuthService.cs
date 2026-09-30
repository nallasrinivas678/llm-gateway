namespace LlmGateway.Assistant.Connectors;

public interface IGoogleOAuthService
{
    // Where to send the user to grant access. `state` should carry the userId so the callback can
    // tie tokens back to the right row without a session.
    string BuildAuthorizationUrl(Guid userId);

    Task ExchangeCodeAsync(Guid userId, string authorizationCode, CancellationToken cancellationToken = default);

    // Returns a currently-valid access token, transparently refreshing (and persisting the
    // refreshed token) if the stored one has expired.
    Task<string> GetValidAccessTokenAsync(Guid userId, CancellationToken cancellationToken = default);
}
