using System.Text.Json;

namespace LlmGateway.Assistant.Tools;

// The shared contract every tool implements (Build order step 1 in docs/plan.md). ExecuteAsync
// takes/returns raw JSON strings rather than typed objects so ToolCallDispatcher can invoke any
// tool uniformly without a big switch statement - each ITool owns its own argument parsing.
public interface ITool
{
    string Name { get; }
    string Description { get; }
    JsonElement ParametersSchema { get; }

    Task<string> ExecuteAsync(string argumentsJson, CancellationToken cancellationToken = default);
}
