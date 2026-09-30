using System.Text.Json;

namespace LlmGateway.Assistant.Models;

// A tool's declared contract, in the shape every major provider's tool/function-calling API
// expects: a name, a description the model uses to decide when to call it, and a JSON Schema
// for its arguments.
public class ToolSchema
{
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public JsonElement ParametersSchema { get; set; }
}
