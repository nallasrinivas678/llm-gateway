namespace LlmGateway.Assistant.Connectors;

public interface IDocsConnector
{
    Task<string> ReadDocumentAsync(Guid userId, string documentId, CancellationToken cancellationToken = default);
    Task AppendToDocumentAsync(Guid userId, string documentId, string text, CancellationToken cancellationToken = default);
}

// STUB - build order step 9. Wire this up the same way CalendarConnector is: get a token via
// IGoogleOAuthService, then call the Google Docs API v1
// (https://docs.googleapis.com/v1/documents/{documentId} for reads,
// documents/{documentId}:batchUpdate with an InsertTextRequest for appends).
public class DocsConnector : IDocsConnector
{
    private readonly HttpClient _httpClient;
    private readonly IGoogleOAuthService _oauthService;

    public DocsConnector(HttpClient httpClient, IGoogleOAuthService oauthService)
    {
        _httpClient = httpClient;
        _oauthService = oauthService;
    }

    public Task<string> ReadDocumentAsync(Guid userId, string documentId, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("DocsConnector.ReadDocumentAsync - see docs/plan.md build order step 9.");

    public Task AppendToDocumentAsync(Guid userId, string documentId, string text, CancellationToken cancellationToken = default) =>
        throw new NotImplementedException("DocsConnector.AppendToDocumentAsync - see docs/plan.md build order step 9.");
}
