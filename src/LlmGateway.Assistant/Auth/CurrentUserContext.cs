namespace LlmGateway.Assistant.Auth;

// Registered Scoped (one instance per request). ChatController sets UserId once, right after JWT
// validation; any tool that acts on behalf of a specific user (Calendar/Gmail/Docs/JobApplication
// tools) injects this instead of ITool.ExecuteAsync taking a userId parameter - keeps the ITool
// contract the same for every tool, whether or not it needs a user identity.
public class CurrentUserContext
{
    public Guid UserId { get; set; }
}
