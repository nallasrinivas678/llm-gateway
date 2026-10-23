using System.Security.Claims;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.DailySummary;

namespace LlmGateway.Assistant.Endpoints;

// Named "Controller" to match ChatController's convention, but implemented as a Minimal API
// endpoint group - see ChatController.cs for why.
public static class DailySummaryController
{
    public static void MapDailySummaryEndpoints(this WebApplication app)
    {
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
}
