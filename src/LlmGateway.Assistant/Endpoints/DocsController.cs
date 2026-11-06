using System.Security.Claims;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Docs;

namespace LlmGateway.Assistant.Endpoints;

public record DocIngestRequestDto(Guid DocumentId);

// Named "Controller" to match the other endpoint files; implemented as Minimal API endpoints.
public static class DocsController
{
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
    }
}
