using System.Security.Claims;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Docs;

namespace LlmGateway.Assistant.Endpoints;

public record DocIngestRequestDto(Guid DocumentId);
public record DocAskRequestDto(Guid DocumentId, string? Question);

// Named "Controller" to match the other endpoint files; implemented as Minimal API endpoints.
public static class DocsController
{
    public const string AskRateLimitPolicy = "docs-ask";
    private const int MaxQuestionLength = 1000;

    public static void MapDocsEndpoints(this WebApplication app)
    {
        // Starts ingest and returns 202 right away; the UI watches documents.status
        // (processing -> ready | failed). Re-calling it re-runs ingest.
        app.MapPost("/assistant/docs", async (
            DocIngestRequestDto request,
            HttpContext httpContext,
            ClaimsPrincipal user,
            DocumentIngestService ingestService,
            CancellationToken cancellationToken) =>
        {
            var userId = SupabaseJwtValidator.GetUserId(user);
            if (userId is null)
            {
                return Results.Unauthorized();
            }

            var storagePath = await ingestService.BeginAsync(userId.Value, request.DocumentId, cancellationToken);
            if (storagePath is null)
            {
                return Results.NotFound();
            }

            var jwt = httpContext.Request.Headers.Authorization.ToString()["Bearer ".Length..];
            _ = Task.Run(() => ingestService.IngestAsync(userId.Value, jwt, request.DocumentId, storagePath));
            return Results.Accepted();
        }).RequireAuthorization();

        // Single JSON response: { answer, sources: [{ page, snippet }] }. Rate limited per user.
        app.MapPost("/assistant/docs/ask", async (
            DocAskRequestDto request,
            ClaimsPrincipal user,
            DocumentAskService askService,
            CancellationToken cancellationToken) =>
        {
            var userId = SupabaseJwtValidator.GetUserId(user);
            if (userId is null)
            {
                return Results.Unauthorized();
            }

            var question = request.Question?.Trim();
            if (string.IsNullOrEmpty(question) || question.Length > MaxQuestionLength)
            {
                return Results.BadRequest(new { detail = $"question is required and must be at most {MaxQuestionLength} characters." });
            }

            var status = await askService.GetStatusAsync(userId.Value, request.DocumentId, cancellationToken);
            if (status is null)
            {
                return Results.NotFound();
            }

            if (status != "ready")
            {
                return Results.Conflict(new { detail = $"Document is {status}; ask again once it is ready." });
            }

            try
            {
                return Results.Ok(await askService.AskAsync(userId.Value, request.DocumentId, question, cancellationToken));
            }
            catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
            {
                return Results.Problem(detail: "The answer service is unavailable. Try again shortly.", statusCode: StatusCodes.Status502BadGateway);
            }
        }).RequireAuthorization().RequireRateLimiting(AskRateLimitPolicy);
    }
}
