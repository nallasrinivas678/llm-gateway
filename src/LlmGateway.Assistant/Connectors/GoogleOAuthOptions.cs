namespace LlmGateway.Assistant.Connectors;

public class GoogleOAuthOptions
{
    public string ClientId { get; set; } = string.Empty;
    public string ClientSecret { get; set; } = string.Empty;
    public string RedirectUri { get; set; } = string.Empty;

    // Space-separated, matching what's persisted in google_tokens.scopes.
    // gmail.readonly was added for the daily-summary feature (searching orders/bills/travel
    // emails) - users who connected Google before this change must re-consent to pick it up,
    // since GoogleOAuthService has no incremental/silent re-scoping.
    public string Scopes { get; set; } =
        "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/documents";
}
