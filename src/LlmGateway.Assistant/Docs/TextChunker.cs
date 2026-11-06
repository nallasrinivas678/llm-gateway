namespace LlmGateway.Assistant.Docs;

public record DocChunk(int Page, string Content);

// Splits one page's text into overlapping windows (~2400 chars is roughly 600 tokens). A chunk
// never crosses a page, so every chunk has exactly one page number to cite.
public static class TextChunker
{
    public static List<DocChunk> Chunk(int page, string text, int maxChars = 2400, int overlap = 300)
    {
        var chunks = new List<DocChunk>();
        text = text.Trim();

        var start = 0;
        while (start < text.Length)
        {
            var end = Math.Min(start + maxChars, text.Length);
            if (end < text.Length)
            {
                // Cut at the last whitespace so words stay whole (unless there's none in the back half).
                var cut = end;
                while (cut > start + maxChars / 2 && !char.IsWhiteSpace(text[cut - 1])) cut--;
                if (cut > start + maxChars / 2) end = cut;
            }

            var piece = text[start..end].Trim();
            if (piece.Length > 0) chunks.Add(new DocChunk(page, piece));
            if (end >= text.Length) break;

            // Next window starts `overlap` chars back, moved forward to a word boundary.
            start = Math.Max(end - overlap, start + 1);
            while (start < end && !char.IsWhiteSpace(text[start])) start++;
        }

        return chunks;
    }
}
