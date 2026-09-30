using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.Connectors;

public interface ISupabaseDataService
{
    Task<Guid> GetOrCreateConversationAsync(Guid userId, Guid? conversationId, CancellationToken cancellationToken = default);
    Task<List<ChatMessage>> GetMessagesAsync(Guid conversationId, CancellationToken cancellationToken = default);
    Task AppendMessageAsync(Guid conversationId, ChatMessage message, CancellationToken cancellationToken = default);
}
