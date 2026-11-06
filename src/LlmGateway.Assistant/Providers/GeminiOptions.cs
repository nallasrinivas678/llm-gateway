namespace LlmGateway.Assistant.Providers;

public class GeminiOptions
{
    public string Endpoint { get; set; } = "https://generativelanguage.googleapis.com";
    public string ApiKey { get; set; } = string.Empty;
    public string Model { get; set; } = "gemini-2.5-flash";

    // PDF Q&A embeddings. Dimensions must match document_chunks.embedding (vector(1536)).
    public string EmbeddingModel { get; set; } = "gemini-embedding-001";
    public int EmbeddingDimensions { get; set; } = 1536;
}
