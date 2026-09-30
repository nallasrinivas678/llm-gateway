using LlmGateway.Assistant.Models;
using LlmGateway.Assistant.Providers;
using LlmGateway.Assistant.Tools;

namespace LlmGateway.Assistant.Orchestrator;

// The agentic loop: message -> LLM -> tool calls -> LLM -> ... -> final answer. Bounded by
// MaxToolCallIterations so a model stuck calling tools forever (a bad tool result confusing it,
// or a genuine loop) fails loudly with a clear exception instead of hanging the request or
// running up an unbounded API bill.
public class ChatOrchestrator
{
    private const int MaxToolCallIterations = 5;

    private readonly ILlmProvider _provider;
    private readonly IToolRegistry _toolRegistry;
    private readonly ToolCallDispatcher _dispatcher;

    public ChatOrchestrator(ILlmProvider provider, IToolRegistry toolRegistry, ToolCallDispatcher dispatcher)
    {
        _provider = provider;
        _toolRegistry = toolRegistry;
        _dispatcher = dispatcher;
    }

    public async Task<ChatResponse> RunAsync(
        ConversationSession session,
        string userMessage,
        string? systemPrompt = null,
        CancellationToken cancellationToken = default)
    {
        session.Append(new ChatMessage { Role = "user", Content = userMessage });

        var tools = _toolRegistry.GetSchemas();

        for (var iteration = 0; iteration < MaxToolCallIterations; iteration++)
        {
            var response = await _provider.CompleteAsync(
                new ChatRequest { Messages = session.Messages, Tools = tools.ToList(), SystemPrompt = systemPrompt },
                cancellationToken);

            if (!response.HasToolCalls)
            {
                session.Append(new ChatMessage { Role = "assistant", Content = response.Content });
                return response;
            }

            session.Append(new ChatMessage { Role = "assistant", Content = response.Content, ToolCalls = response.ToolCalls });

            var results = await _dispatcher.DispatchAsync(response.ToolCalls, cancellationToken);
            foreach (var result in results)
            {
                session.Append(new ChatMessage { Role = "tool", Content = result.Content, ToolCallId = result.ToolCallId });
            }
        }

        throw new InvalidOperationException($"Exceeded max tool-call iterations ({MaxToolCallIterations}) without a final answer.");
    }
}
