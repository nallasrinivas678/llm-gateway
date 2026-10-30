using System.Security.Claims;
using System.Text.Json;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.DailySummary;

namespace LlmGateway.Assistant.Endpoints;

// Named "Controller" to match ChatController's convention, but implemented as a Minimal API
// endpoint group - see ChatController.cs for why.
public static class DailySummaryController
{
    private static readonly JsonSerializerOptions SseJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static void MapDailySummaryEndpoints(this WebApplication app)
    {
        // SSE variant of the endpoint below: streams a "fetching" status, then the summary text
        // as Gemini writes it, then a final "done" event carrying the same payload the
        // non-streaming endpoint returns in one shot (emails/events/generatedAtUtc). Kept
        // alongside the original rather than replacing it - simpler clients can keep polling the
        // plain GET.
        app.MapGet("/assistant/daily-summary/stream", async (
            HttpContext httpContext,
            ClaimsPrincipal user,
            DailySummaryService dailySummaryService,
            CurrentUserContext currentUserContext,
            CancellationToken cancellationToken) =>
        {
            var userId = SupabaseJwtValidator.GetUserId(user);
            if (userId is null)
            {
                httpContext.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }

            currentUserContext.UserId = userId.Value;

            var response = httpContext.Response;
            response.ContentType = "text/event-stream";
            response.Headers.CacheControl = "no-cache";
            response.Headers["X-Accel-Buffering"] = "no";

            try
            {
                await foreach (var streamEvent in dailySummaryService.StreamAsync(userId.Value, cancellationToken))
                {
                    await WriteEventAsync(response, streamEvent, cancellationToken);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                // Client disconnected or the request was aborted - nothing left to write.
            }
            catch (InvalidOperationException ex)
            {
                await WriteSseAsync(response, "error", JsonSerializer.Serialize(new { detail = ex.Message }, SseJsonOptions), cancellationToken);
            }
        }).RequireAuthorization();

        app.MapGet("/assistant/daily-summary", async (
            ClaimsPrincipal user,
            DailySummaryService dailySummaryService,
            CurrentUserContext currentUserContext,
            CancellationToken cancellationToken) =>
        {
            var userId = SupabaseJwtValidator.GetUserId(user);
            if (userId is null)
            {
                return Results.Unauthorized();
            }

            currentUserContext.UserId = userId.Value;

            try
            {
                var summary = await dailySummaryService.BuildAsync(userId.Value, cancellationToken);
                return Results.Ok(summary);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Problem(detail: ex.Message, statusCode: StatusCodes.Status502BadGateway);
            }
        }).RequireAuthorization();
    }

    private static Task WriteEventAsync(HttpResponse response, DailySummaryStreamEvent streamEvent, CancellationToken cancellationToken) =>
        streamEvent switch
        {
            DailySummaryStreamEvent.Status s => WriteSseAsync(response, "status", JsonSerializer.Serialize(new { message = s.Message }, SseJsonOptions), cancellationToken),
            DailySummaryStreamEvent.Chunk c => WriteSseAsync(response, "chunk", JsonSerializer.Serialize(new { text = c.Text }, SseJsonOptions), cancellationToken),
            DailySummaryStreamEvent.Done d => WriteSseAsync(response, "done", JsonSerializer.Serialize(d.Result, SseJsonOptions), cancellationToken),
            _ => Task.CompletedTask
        };

    private static async Task WriteSseAsync(HttpResponse response, string eventName, string json, CancellationToken cancellationToken)
    {
        await response.WriteAsync($"event: {eventName}\n", cancellationToken);
        await response.WriteAsync($"data: {json}\n\n", cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }
}
