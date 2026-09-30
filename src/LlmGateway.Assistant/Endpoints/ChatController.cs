using System.Security.Claims;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Connectors;
using LlmGateway.Assistant.Orchestrator;

namespace LlmGateway.Assistant.Endpoints;

// Named "Controller" per docs/plan.md, but implemented as a Minimal API endpoint group -
// LlmGateway.Api has no MVC controllers, and this project follows the same convention.
// MapChatEndpoints is called once from Program.cs.
public static class ChatController
{
    public static void MapChatEndpoints(this WebApplication app)
    {
        app.MapPost("/assistant/chat", async (
            ChatRequestDto request,
            ClaimsPrincipal user,
            ISupabaseDataService dataService,
            ChatOrchestrator orchestrator,
            CurrentUserContext currentUserContext,
            CancellationToken cancellationToken) =>
        {
            var userId = SupabaseJwtValidator.GetUserId(user);
            if (userId is null)
            {
                return Results.Unauthorized();
            }

            currentUserContext.UserId = userId.Value;

            var conversationId = await dataService.GetOrCreateConversationAsync(
                userId.Value,
                request.ConversationId is null ? null : Guid.Parse(request.ConversationId),
                cancellationToken);

            var existingMessages = await dataService.GetMessagesAsync(conversationId, cancellationToken);
            var session = new ConversationSession(conversationId, existingMessages);

            var response = await orchestrator.RunAsync(session, request.Message, cancellationToken: cancellationToken);

            // ConversationSession.Messages holds the full history; only persist what this turn
            // actually appended (the new user message plus any assistant/tool round-trips).
            var newMessages = session.Messages.Skip(existingMessages.Count).ToList();
            foreach (var message in newMessages)
            {
                await dataService.AppendMessageAsync(conversationId, message, cancellationToken);
            }

            var toolsExecuted = newMessages
                .Where(m => m.Role == "assistant" && m.ToolCalls is { Count: > 0 })
                .SelectMany(m => m.ToolCalls!.Select(tc => tc.ToolName))
                .Distinct()
                .ToList();

            return Results.Ok(new ChatResponseDto(conversationId.ToString(), response.Content, toolsExecuted));
        }).RequireAuthorization();
    }
}

public record ChatRequestDto(string? ConversationId, string Message);

public record ChatResponseDto(string ConversationId, string Reply, List<string> ToolCallsExecuted);
