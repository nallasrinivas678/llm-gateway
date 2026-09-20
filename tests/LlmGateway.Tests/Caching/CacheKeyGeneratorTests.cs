using LlmGateway.Api.Caching;
using LlmGateway.Api.Models;
using Xunit;

namespace LlmGateway.Tests.Caching;

public class CacheKeyGeneratorTests
{
    [Fact]
    public void Generate_ReturnsSameKey_ForIdenticalRequests()
    {
        var a = BuildRequest();
        var b = BuildRequest();

        Assert.Equal(CacheKeyGenerator.Generate(a), CacheKeyGenerator.Generate(b));
    }

    [Fact]
    public void Generate_IgnoresCallerId()
    {
        var a = BuildRequest();
        a.CallerId = "caller-a";
        var b = BuildRequest();
        b.CallerId = "caller-b";

        Assert.Equal(CacheKeyGenerator.Generate(a), CacheKeyGenerator.Generate(b));
    }

    [Fact]
    public void Generate_ReturnsDifferentKey_WhenMessageContentDiffers()
    {
        var a = BuildRequest();
        var b = BuildRequest();
        b.Messages[0].Content = "a different question";

        Assert.NotEqual(CacheKeyGenerator.Generate(a), CacheKeyGenerator.Generate(b));
    }

    [Fact]
    public void Generate_ReturnsDifferentKey_WhenModelDiffers()
    {
        var a = BuildRequest();
        var b = BuildRequest();
        b.Model = "a-different-model";

        Assert.NotEqual(CacheKeyGenerator.Generate(a), CacheKeyGenerator.Generate(b));
    }

    private static ChatCompletionRequest BuildRequest() => new()
    {
        Model = "gpt-4o-mini",
        Temperature = 0,
        CallerId = "irrelevant",
        Messages = new List<ChatMessage> { new() { Role = "user", Content = "hello" } }
    };
}
