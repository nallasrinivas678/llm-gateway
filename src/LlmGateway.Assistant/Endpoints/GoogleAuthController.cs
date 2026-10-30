using System.Security.Claims;
using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Connectors;

namespace LlmGateway.Assistant.Endpoints;

// Wires up the Google OAuth authorization-code flow that GoogleOAuthService already implements
// (BuildAuthorizationUrl / ExchangeCodeAsync) but that had no HTTP route - see docs/plan.md build
// order step 8/9. /start is a normal authenticated API call that hands the frontend a URL to
// navigate to, rather than redirecting itself, since a plain browser navigation to /start
// wouldn't carry the caller's bearer JWT. /callback is Google redirecting the user's browser back
// to us - there's no bearer token on that request, so the user is identified via the `state`
// param instead, exactly as GoogleOAuthService.BuildAuthorizationUrl already sets it up.
public static class GoogleAuthController
{
    public static void MapGoogleAuthEndpoints(this WebApplication app)
    {
        app.MapGet("/auth/google/start", (ClaimsPrincipal user, IGoogleOAuthService oauthService) =>
        {
            var userId = SupabaseJwtValidator.GetUserId(user);
            if (userId is null)
            {
                return Results.Unauthorized();
            }

            return Results.Ok(new GoogleAuthStartResponseDto(oauthService.BuildAuthorizationUrl(userId.Value)));
        }).RequireAuthorization();

        app.MapGet("/auth/google/callback", async (
            string? code,
            string? state,
            string? error,
            IGoogleOAuthService oauthService,
            CancellationToken cancellationToken) =>
        {
            if (!string.IsNullOrEmpty(error))
            {
                return HtmlResult($"Google sign-in was cancelled or denied ({error}). You can close this window.");
            }

            if (string.IsNullOrEmpty(code) || !Guid.TryParse(state, out var userId))
            {
                return Results.BadRequest("Missing or invalid 'code'/'state' query parameters.");
            }

            try
            {
                await oauthService.ExchangeCodeAsync(userId, code, cancellationToken);
            }
            catch (Exception ex)
            {
                return Results.Problem(detail: ex.Message, statusCode: StatusCodes.Status502BadGateway);
            }

            return HtmlResult("Google account connected. You can close this window and return to the app.");
        });
    }

    private static IResult HtmlResult(string message) =>
        Results.Content($"<html><body><p>{message}</p></body></html>", "text/html");
}

public record GoogleAuthStartResponseDto(string AuthorizationUrl);
