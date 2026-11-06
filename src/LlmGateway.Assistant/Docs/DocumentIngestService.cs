using System.Globalization;
using LlmGateway.Assistant.Connectors;
using Microsoft.Extensions.Options;
using Npgsql;
using UglyToad.PdfPig;
using UglyToad.PdfPig.DocumentLayoutAnalysis.TextExtractor;

namespace LlmGateway.Assistant.Docs;

// Downloads a user's PDF, extracts text per page, chunks, embeds and stores it. Failures end in
// documents.status = 'failed' with a short readable message; unexpected errors are logged and
// shown generically.
public class DocumentIngestService
{
    private const int MaxPages = 200;
    private const int MinTextChars = 200;   // below this we assume a scan with no text layer
    private const int EmbedBatchSize = 100;

    private readonly HttpClient _httpClient;
    private readonly UserDb _userDb;
    private readonly GeminiEmbeddingClient _embeddings;
    private readonly SupabaseOptions _supabase;
    private readonly ILogger<DocumentIngestService> _logger;

    public DocumentIngestService(
        HttpClient httpClient,
        UserDb userDb,
        GeminiEmbeddingClient embeddings,
        IOptions<SupabaseOptions> supabase,
        ILogger<DocumentIngestService> logger)
    {
        _httpClient = httpClient;
        _userDb = userDb;
        _embeddings = embeddings;
        _supabase = supabase.Value;
        _logger = logger;
    }

    // Marks the document 'processing' and returns its storage path. Returns null when the
    // document doesn't exist or isn't the caller's (RLS hides other users' rows).
    public Task<string?> BeginAsync(Guid userId, Guid documentId, CancellationToken cancellationToken = default) =>
        _userDb.RunAsync<string?>(userId, async connection =>
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE documents SET status = 'processing', error = NULL WHERE id = $1 RETURNING storage_path";
            command.Parameters.AddWithValue(documentId);
            return (string?)await command.ExecuteScalarAsync(cancellationToken);
        }, cancellationToken);

    public async Task IngestAsync(Guid userId, string userJwt, Guid documentId, string storagePath)
    {
        try
        {
            var pdf = await DownloadAsync(storagePath, userJwt);
            var pages = ExtractPages(pdf);

            var chunks = pages.SelectMany(p => TextChunker.Chunk(p.Page, p.Text)).ToList();
            var vectors = new List<float[]>(chunks.Count);
            for (var i = 0; i < chunks.Count; i += EmbedBatchSize)
            {
                var batch = chunks.Skip(i).Take(EmbedBatchSize).Select(c => c.Content).ToList();
                vectors.AddRange(await _embeddings.EmbedAsync(batch, "RETRIEVAL_DOCUMENT"));
            }

            await _userDb.RunAsync(userId, async connection =>
            {
                // Replace any earlier chunks and mark ready in one transaction, so re-runs are idempotent.
                await using (var delete = connection.CreateCommand())
                {
                    delete.CommandText = "DELETE FROM document_chunks WHERE document_id = $1";
                    delete.Parameters.AddWithValue(documentId);
                    await delete.ExecuteNonQueryAsync();
                }

                for (var i = 0; i < chunks.Count; i++)
                {
                    await using var insert = connection.CreateCommand();
                    insert.CommandText = """
                        INSERT INTO document_chunks (document_id, chunk_index, page, content, embedding)
                        VALUES ($1, $2, $3, $4, $5::extensions.vector)
                        """;
                    insert.Parameters.AddWithValue(documentId);
                    insert.Parameters.AddWithValue(i);
                    insert.Parameters.AddWithValue(chunks[i].Page);
                    insert.Parameters.AddWithValue(chunks[i].Content);
                    insert.Parameters.AddWithValue(ToVectorLiteral(vectors[i]));
                    await insert.ExecuteNonQueryAsync();
                }

                await SetStatusAsync(connection, documentId, "ready", null, pages.Count);
                return 0;
            });
        }
        catch (IngestException ex)
        {
            await FailAsync(userId, documentId, ex.Message);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Ingest failed for document {DocumentId}", documentId);
            await FailAsync(userId, documentId, "Processing failed. Please try again.");
        }
    }

    private async Task<byte[]> DownloadAsync(string storagePath, string userJwt)
    {
        var url = $"{_supabase.Url.TrimEnd('/')}/storage/v1/object/documents/{storagePath}";
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("apikey", _supabase.AnonKey);
        request.Headers.Add("Authorization", $"Bearer {userJwt}");

        using var response = await _httpClient.SendAsync(request);
        if (!response.IsSuccessStatusCode)
        {
            throw new IngestException("Could not download the uploaded file.");
        }

        return await response.Content.ReadAsByteArrayAsync();
    }

    private static List<(int Page, string Text)> ExtractPages(byte[] pdf)
    {
        PdfDocument document;
        try
        {
            document = PdfDocument.Open(pdf);
        }
        catch (Exception)
        {
            throw new IngestException("This file couldn't be read as a PDF.");
        }

        using (document)
        {
            if (document.NumberOfPages > MaxPages)
            {
                throw new IngestException($"This PDF has {document.NumberOfPages} pages; the limit is {MaxPages}.");
            }

            var pages = document.GetPages()
                .Select(page => (page.Number, Text: ContentOrderTextExtractor.GetText(page)))
                .ToList();

            if (pages.Sum(p => p.Text.Trim().Length) < MinTextChars)
            {
                throw new IngestException("No text layer found; OCR is not supported yet.");
            }

            return pages;
        }
    }

    private Task FailAsync(Guid userId, Guid documentId, string message) =>
        _userDb.RunAsync(userId, async connection =>
        {
            await SetStatusAsync(connection, documentId, "failed", message, null);
            return 0;
        });

    private static async Task SetStatusAsync(NpgsqlConnection connection, Guid documentId, string status, string? error, int? pageCount)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE documents SET status = $1, error = $2, page_count = COALESCE($3, page_count) WHERE id = $4";
        command.Parameters.AddWithValue(status);
        command.Parameters.AddWithValue((object?)error ?? DBNull.Value);
        command.Parameters.AddWithValue((object?)pageCount ?? DBNull.Value);
        command.Parameters.AddWithValue(documentId);
        await command.ExecuteNonQueryAsync();
    }

    // pgvector's text format: [0.1,0.2,...]. Avoids needing an extra Npgsql plugin package.
    private static string ToVectorLiteral(float[] values) =>
        "[" + string.Join(",", values.Select(v => v.ToString("G9", CultureInfo.InvariantCulture))) + "]";

    private class IngestException : Exception
    {
        public IngestException(string message) : base(message) { }
    }
}
