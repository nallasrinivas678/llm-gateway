// Splits one page's text into overlapping windows (about 2400 characters is roughly 600 tokens). A
// chunk never crosses a page, so every chunk has exactly one page number to cite. Ported from the
// .NET TextChunker, with the same defaults.
export interface DocChunk {
  page: number;
  content: string;
}

export function chunkPage(page: number, rawText: string, maxChars = 2400, overlap = 300): DocChunk[] {
  const text = rawText.trim();
  const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
  const chunks: DocChunk[] = [];
  const half = Math.floor(maxChars / 2);

  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      // Cut at the last whitespace so words stay whole (unless there is none in the back half).
      let cut = end;
      while (cut > start + half && !isSpace(text[cut - 1])) cut--;
      if (cut > start + half) end = cut;
    }

    const piece = text.slice(start, end).trim();
    if (piece) chunks.push({ page, content: piece });
    if (end >= text.length) break;

    // The next window starts `overlap` characters back, moved forward to a word boundary.
    start = Math.max(end - overlap, start + 1);
    while (start < end && !isSpace(text[start])) start++;
  }
  return chunks;
}
