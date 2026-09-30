using LlmGateway.Assistant.Models;

namespace LlmGateway.Assistant.Tools;

// Built from every ITool registered in DI (IEnumerable<ITool>, the same "multi-register an
// interface, resolve as a collection" pattern LlmGateway.Api uses for ILlmProvider). Adding a new
// tool means registering it in Program.cs - nothing here needs to change.
public class ToolRegistry : IToolRegistry
{
    private readonly Dictionary<string, ITool> _toolsByName;

    public ToolRegistry(IEnumerable<ITool> tools)
    {
        _toolsByName = tools.ToDictionary(t => t.Name);
    }

    public IReadOnlyList<ToolSchema> GetSchemas() =>
        _toolsByName.Values
            .Select(t => new ToolSchema { Name = t.Name, Description = t.Description, ParametersSchema = t.ParametersSchema })
            .ToList();

    public ITool? Find(string name) => _toolsByName.GetValueOrDefault(name);
}
