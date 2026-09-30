using LlmGateway.Assistant.Models;
using LlmGateway.Assistant.Tools;
using Microsoft.Extensions.Logging;

namespace LlmGateway.Assistant.Orchestrator;

// Executes every ToolCallRequest an LLM turn asked for. A tool throwing (a bad argument, a
// downstream API failing) becomes a ToolResult with IsError = true rather than an exception that
// would crash the whole conversation - the LLM gets to see the failure and decide what to do
// next (retry with different arguments, apologize to the user, try a different tool), the same
// way a human assistant would react to a failed action rather than the whole interaction dying.
public class ToolCallDispatcher
{
    private readonly IToolRegistry _toolRegistry;
    private readonly ILogger<ToolCallDispatcher> _logger;

    public ToolCallDispatcher(IToolRegistry toolRegistry, ILogger<ToolCallDispatcher> logger)
    {
        _toolRegistry = toolRegistry;
        _logger = logger;
    }

    public async Task<List<ToolResult>> DispatchAsync(IEnumerable<ToolCallRequest> toolCalls, CancellationToken cancellationToken = default)
    {
        var results = new List<ToolResult>();

        foreach (var call in toolCalls)
        {
            var tool = _toolRegistry.Find(call.ToolName);
            if (tool is null)
            {
                _logger.LogWarning("Requested unknown tool {ToolName}.", call.ToolName);
                results.Add(new ToolResult { ToolCallId = call.Id, Content = $"Unknown tool: {call.ToolName}", IsError = true });
                continue;
            }

            try
            {
                var content = await tool.ExecuteAsync(call.ArgumentsJson, cancellationToken);
                results.Add(new ToolResult { ToolCallId = call.Id, Content = content });
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Tool {ToolName} failed.", call.ToolName);
                results.Add(new ToolResult { ToolCallId = call.Id, Content = $"Tool execution failed: {ex.Message}", IsError = true });
            }
        }

        return results;
    }
}
