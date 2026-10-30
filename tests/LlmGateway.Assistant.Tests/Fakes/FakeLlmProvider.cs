using System.Runtime.CompilerServices;
using LlmGateway.Assistant.Models;
using LlmGateway.Assistant.Providers;

namespace LlmGateway.Assistant.Tests.Fakes;

public class FakeLlmProvider : ILlmProvider
{
    private readonly string _content;
    private readonly int _throwCount;
    private int _callCount;

    public List<ChatRequest> ReceivedRequests { get; } = new();

    public FakeLlmProvider(string content = "Here is your daily summary.", int throwCount = 0)
    {
        _content = content;
        _throwCount = throwCount;
    }

    public Task<ChatResponse> CompleteAsync(ChatRequest request, CancellationToken cancellationToken = default)
    {
        ReceivedRequests.Add(request);
        _callCount++;

        if (_callCount <= _throwCount)
        {
            throw new HttpRequestException("Simulated transient LLM failure.");
        }

        return Task.FromResult(new ChatResponse { Content = _content });
    }

    public async IAsyncEnumerable<string> StreamAsync(ChatRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var response = await CompleteAsync(request, cancellationToken);
        yield return response.Content;
    }
}
