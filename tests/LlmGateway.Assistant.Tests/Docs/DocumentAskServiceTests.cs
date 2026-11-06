using LlmGateway.Assistant.Docs;
using Xunit;

namespace LlmGateway.Assistant.Tests.Docs;

public class DocumentAskServiceTests
{
    [Fact]
    public void FilterRelevant_DropsChunksBelowThresholdAndSortsBestFirst()
    {
        var chunks = new List<RetrievedChunk>
        {
            new(1, "weak", 0.31),
            new(2, "good", 0.72),
            new(3, "best", 0.88)
        };

        var relevant = DocumentAskService.FilterRelevant(chunks, 0.5);

        Assert.Equal(new[] { 3, 2 }, relevant.Select(c => c.Page));
    }

    [Fact]
    public void FilterRelevant_NothingAboveThreshold_IsEmpty()
    {
        var chunks = new List<RetrievedChunk> { new(1, "weak", 0.2) };

        Assert.Empty(DocumentAskService.FilterRelevant(chunks, 0.5));
    }

    [Fact]
    public void BuildUserMessage_LabelsEachExcerptWithItsPageAndEndsWithTheQuestion()
    {
        var chunks = new List<RetrievedChunk> { new(4, "Refunds take 5 days.", 0.9), new(9, "Contact support.", 0.7) };

        var message = DocumentAskService.BuildUserMessage("How long do refunds take?", chunks);

        Assert.Contains("[Page 4]\nRefunds take 5 days.", message);
        Assert.Contains("[Page 9]\nContact support.", message);
        Assert.EndsWith("Question: How long do refunds take?", message);
    }

    [Fact]
    public void VectorLiteral_UsesInvariantCultureAndBrackets()
    {
        Assert.Equal("[0.5,-1,0.25]", UserDb.VectorLiteral(new[] { 0.5f, -1f, 0.25f }));
    }
}
