using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;

namespace LlmGateway.Assistant.Auth;

// Validates the mobile app's Supabase JWT (Build order step 5). Supabase issues standard HS256
// JWTs signed with the project's JWT secret - this wires that up as ASP.NET Core's JWT bearer
// authentication rather than hand-rolling token parsing, so every endpoint just needs
// [Authorize] / RequireAuthorization() instead of custom middleware.
public static class SupabaseJwtValidator
{
    public static IServiceCollection AddSupabaseJwtBearer(this IServiceCollection services, SupabaseAuthOptions options)
    {
        // SymmetricSecurityKey throws for a zero-length key - and it throws lazily, the first
        // time JwtBearerOptions is materialized to handle an incoming request, not at startup.
        // Left unguarded, an unset JwtSecret would crash EVERY request (even unauthenticated ones
        // like /health), since UseAuthentication() runs for the whole pipeline. Substitute a
        // random key instead: initialization succeeds, and since no real token was ever signed
        // with it, every token predictably fails validation (an ordinary 401) instead of the
        // whole app going down.
        var secretBytes = string.IsNullOrEmpty(options.JwtSecret)
            ? RandomNumberGenerator.GetBytes(32)
            : Encoding.UTF8.GetBytes(options.JwtSecret);

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(bearerOptions =>
            {
                bearerOptions.TokenValidationParameters = new TokenValidationParameters
                {
                    ValidateIssuerSigningKey = true,
                    IssuerSigningKey = new SymmetricSecurityKey(secretBytes),
                    ValidateIssuer = !string.IsNullOrEmpty(options.Issuer),
                    ValidIssuer = options.Issuer,
                    ValidateAudience = false,
                    ValidateLifetime = true
                };
            });

        if (string.IsNullOrEmpty(options.JwtSecret))
        {
            services.AddSingleton<IStartupFilter>(new WarnMissingJwtSecretStartupFilter());
        }

        return services;
    }

    // Logs a startup warning (once, via the standard logging pipeline) rather than failing to
    // build the app - this project is meant to be runnable before a real Supabase project (and
    // therefore a real JWT secret) exists yet, per docs/plan.md's milestone checklist.
    private class WarnMissingJwtSecretStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.ApplicationServices.GetRequiredService<ILoggerFactory>()
                .CreateLogger("SupabaseJwtValidator")
                .LogWarning("SupabaseAuth:JwtSecret is not set - every request to an authorized endpoint will be rejected until it's configured.");
            next(app);
        };
    }

    // Supabase JWTs carry the user id in the standard "sub" claim.
    public static Guid? GetUserId(ClaimsPrincipal user)
    {
        var sub = user.FindFirstValue(JwtRegisteredClaimNames.Sub) ?? user.FindFirstValue(ClaimTypes.NameIdentifier);
        return sub is not null && Guid.TryParse(sub, out var userId) ? userId : null;
    }
}
