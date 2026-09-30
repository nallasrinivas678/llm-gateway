using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.Orchestrator;

// The in-memory working set for one chat turn: the full message history for a conversation, plus
// whatever gets appended during this turn (user message, assistant/tool round-trips). Persisting
// it back to Supabase is the caller's (ChatController's) responsibility, not this class's -
// keeping persistence out of here means ChatOrchestrator/ConversationSession stay testable with
// no database at all.
public class ConversationSession
{
    public Guid ConversationId { get; }
    public List<ChatMessage> Messages { get; }

    public ConversationSession(Guid conversationId, List<ChatMessage> messages)
    {
        ConversationId = conversationId;
        Messages = messages;
    }

    public void Append(ChatMessage message) => Messages.Add(message);
}
