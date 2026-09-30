using System.Text.Json;
using LlmGateway.Assistant.Models;
using Npgsql;

namespace LlmGateway.Assistant.Connectors;

// Reads/writes the `conversations` and `messages` tables exactly as defined in docs/plan.md
// section 1. Uses the service_role connection - see SupabaseOptions for why bypassing RLS here
// is intentional, not an oversight.
public class SupabaseDataService : ISupabaseDataService
{
    private readonly NpgsqlDataSource _dataSource;

    public SupabaseDataService(NpgsqlDataSource dataSource)
    {
        _dataSource = dataSource;
    }

    public async Task<Guid> GetOrCreateConversationAsync(Guid userId, Guid? conversationId, CancellationToken cancellationToken = default)
    {
        if (conversationId is not null)
        {
            return conversationId.Value;
        }

        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "INSERT INTO conversations (user_id) VALUES ($1) RETURNING id";
        command.Parameters.AddWithValue(userId);

        var newId = await command.ExecuteScalarAsync(cancellationToken);
        return (Guid)newId!;
    }

    public async Task<List<ChatMessage>> GetMessagesAsync(Guid conversationId, CancellationToken cancellationToken = default)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT role, content, tool_call_id, tool_calls FROM messages WHERE conversation_id = $1 ORDER BY created_at";
        command.Parameters.AddWithValue(conversationId);

        var messages = new List<ChatMessage>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var toolCallsJson = reader.IsDBNull(3) ? null : reader.GetString(3);
            messages.Add(new ChatMessage
            {
                Role = reader.GetString(0),
                Content = reader.GetString(1),
                ToolCallId = reader.IsDBNull(2) ? null : reader.GetString(2),
                ToolCalls = toolCallsJson is null ? null : JsonSerializer.Deserialize<List<ToolCallRequest>>(toolCallsJson)
            });
        }

        return messages;
    }

    public async Task AppendMessageAsync(Guid conversationId, ChatMessage message, CancellationToken cancellationToken = default)
    {
        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            INSERT INTO messages (conversation_id, role, content, tool_call_id, tool_calls)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            """;
        command.Parameters.AddWithValue(conversationId);
        command.Parameters.AddWithValue(message.Role);
        command.Parameters.AddWithValue(message.Content);
        command.Parameters.AddWithValue((object?)message.ToolCallId ?? DBNull.Value);
        command.Parameters.AddWithValue((object?)(message.ToolCalls is null ? null : JsonSerializer.Serialize(message.ToolCalls)) ?? DBNull.Value);

        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}
