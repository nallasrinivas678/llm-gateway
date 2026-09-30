using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.Tools;

public interface IToolRegistry
{
    IReadOnlyList<ToolSchema> GetSchemas();
    ITool? Find(string name);
}
