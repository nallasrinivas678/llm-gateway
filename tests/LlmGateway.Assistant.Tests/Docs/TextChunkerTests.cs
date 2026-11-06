using LlmGateway.Assistant.Docs;
using Xunit;

namespace LlmGateway.Assistant.Tests.Docs;

public class TextChunkerTests
{
    [Fact]
    public void Chunk_ShortText_IsOneChunkWithThePage()
    {
        var chunks = TextChunker.Chunk(7, "Hello world.");

        var chunk = Assert.Single(chunks);
        Assert.Equal(7, chunk.Page);
        Assert.Equal("Hello world.", chunk.Content);
    }

    [Fact]
    public void Chunk_EmptyOrWhitespace_IsNoChunks()
    {
        Assert.Empty(TextChunker.Chunk(1, "   \n  "));
    }

    [Fact]
    public void Chunk_LongText_SplitsWithinLimitKeepingWordsAndOverlap()
    {
        var words = Enumerable.Range(0, 2000).Select(i => $"word{i}").ToList();
        var text = string.Join(" ", words);

        var chunks = TextChunker.Chunk(3, text, maxChars: 500, overlap: 100);

        Assert.True(chunks.Count > 1);
        Assert.All(chunks, c =>
        {
            Assert.Equal(3, c.Page);
            Assert.True(c.Content.Length <= 500);
            // every chunk is made of whole words from the source
            Assert.All(c.Content.Split(' '), w => Assert.Contains(w, words));
        });

        // consecutive chunks overlap, and together they cover the whole text
        for (var i = 1; i < chunks.Count; i++)
        {
            var lastWordOfPrevious = chunks[i - 1].Content.Split(' ').Last();
            Assert.Contains(lastWordOfPrevious, chunks[i].Content);
        }
        Assert.Equal(words.First(), chunks.First().Content.Split(' ').First());
        Assert.Equal(words.Last(), chunks.Last().Content.Split(' ').Last());
    }
}
