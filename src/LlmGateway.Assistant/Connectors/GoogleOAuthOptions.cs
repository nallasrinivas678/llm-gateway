namespace LlmGateway.Assistant.Connectors;

public class GoogleOAuthOptions
{
    public string ClientId { get; set; } = string.Empty;
    public string ClientSecret { get; set; } = string.Empty;
    public string RedirectUri { get; set; } = string.Empty;

    // Space-separated, matching what's persisted in google_tokens.scopes.
    public string Scopes { get; set; } =
        "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/documents";
}
