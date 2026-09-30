using System.Text.Json;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Connectors;

namespace LlmGateway.Assistant.Tools;

// Structure is real (schema, DI wiring); execution delegates to IGmailConnector, which is a stub
// pending build order step 9. ToolCallDispatcher already turns a thrown NotImplementedException
// into a normal error ToolResult, so registering this tool now is safe even before the connector
// is finished - the LLM just sees "tool execution failed" if it tries to use it.
public class SendEmailTool : ITool
{
    private static readonly JsonElement Schema = JsonDocument.Parse("""
        {
          "type": "object",
          "properties": {
            "to": { "type": "string", "description": "Recipient email address" },
            "subject": { "type": "string" },
            "body": { "type": "string" }
          },
          "required": ["to", "subject", "body"]
        }
        """).RootElement;

    private readonly IGmailConnector _gmail;
    private readonly CurrentUserContext _currentUser;

    public SendEmailTool(IGmailConnector gmail, CurrentUserContext currentUser)
    {
        _gmail = gmail;
        _currentUser = currentUser;
    }

    public string Name => "send_email";
    public string Description => "Sends an email from the user's Gmail account.";
    public JsonElement ParametersSchema => Schema;

    public async Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default)
    {
        var args = JsonDocument.Parse(argumentsJson).RootElement;

        await _gmail.SendEmailAsync(
            _currentUser.UserId,
            args.GetProperty("to").GetString() ?? string.Empty,
            args.GetProperty("subject").GetString() ?? string.Empty,
            args.GetProperty("body").GetString() ?? string.Empty,
            cancellationToken);

        return "Email sent.";
    }
}
