namespace LlmGateway.Assistant.Models;

// One tool invocation the LLM asked for. ArgumentsJson is kept as a raw string (not deserialized
// here) because each ITool implementation knows its own argument shape - forcing a shared
// deserialization step here would mean this file has to change every time a new tool is added.
public class ToolCallRequest
{
    public string Id { get; set; } = string.Empty;
    public string ToolName { get; set; } = string.Empty;
    public string ArgumentsJson { get; set; } = "{}";
}
