namespace LlmGateway.Assistant.Connectors;

public interface IGmailConnector
{
    Task SendEmailAsync(Guid userId, string to, string subject, string body, CancellationToken cancellationToken = default);
}

// STUB - build order step 9 ("Gmail, Docs connectors - added incrementally, same OAuth service").
// Wire this up the same way CalendarConnector is: IGoogleOAuthService.GetValidAccessTokenAsync
// for the token, then POST to https://gmail.googleapis.com/gmail/v1/users/me/messages/send with
// a base64url-encoded RFC 2822 MIME message as the `raw` field.
public class GmailConnector : IGmailConnector
{
    private readonly HttpClient _httpClient;
    private readonly IGoogleOAuthService _oauthService;

    public GmailConnector(HttpClient httpClient, IGoogleOAuthService oauthService)
    {
        _httpClient = httpClient;
        _oauthService = oauthService;
    }

    public Task SendEmailAsync(Guid userId, string to, string subject, string body, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("GmailConnector.SendEmailAsync - see docs/plan.md build order step 9.");
}
