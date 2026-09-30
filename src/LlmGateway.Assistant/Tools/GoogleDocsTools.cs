using System.Text.Json;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Connectors;

namespace LlmGateway.Assistant.Tools;

// Structure is real; execution delegates to IDocsConnector, a stub pending build order step 9.
public class ReadDocumentTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": {
            "documentId": { "type": "string", "description": "Google Docs document ID" }
          },
          "required": ["documentId"]
        }
        """).RootElement;

    private readonly IDocsConnector _docs;
    private readonly CurrentUserContext _currentUser;

    public ReadDocumentTool(IDocsConnector docs, CurrentUserContext currentUser)
    {
        _docs = docs;
        _currentUser = currentUser;
    }

    public string Name => "read_google_doc";
    public string Description => "Reads the plain-text content of a Google Doc the user has access to.";
    public JsonElement ParametersSchema => Schema;

    public Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        var args = JsonDocument.Parse(argumentsJson).RootElement;
        return _docs.ReadDocumentAsync(_currentUser.UserId, args.GetProperty("documentId").GetString() ?? string.Empty, cancellationToken);
    }
}

public class AppendToDocumentTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": {
            "documentId": { "type": "string" },
            "text": { "type": "string" }
          },
          "required": ["documentId", "text"]
        }
        """).RootElement;

    private readonly IDocsConnector _docs;
    private readonly CurrentUserContext _currentUser;

    public AppendToDocumentTool(IDocsConnector docs, CurrentUserContext currentUser)
    {
        _docs = docs;
        _currentUser = currentUser;
    }

    public string Name => "append_to_google_doc";
    public string Description => "Appends text to the end of a Google Doc the user has access to.";
    public JsonElement ParametersSchema => Schema;

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        var args = JsonDocument.Parse(argumentsJson).RootElement;
        await _docs.AppendToDocumentAsync(
            _currentUser.UserId,
            args.GetProperty("documentId").GetString() ?? string.Empty,
            args.GetProperty("text").GetString() ?? string.Empty,
            cancellationToken);

        return "Appended.";
    }
}
