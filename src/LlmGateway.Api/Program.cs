using System.Diagnostics;
using System.Net.Http.Headers;
using LlmGateway.Api.Cost;
using LlmGateway.Api.Models;
using LlmGateway.Api.Providers;
using LlmGateway.Api.Resilience;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.Configure<AzureOpenAiOptions>(builder.Configuration.GetSection("Providers:AzureOpenAI"));
builder.Services.Configure<OpenAiOptions>(builder.Configuration.GetSection("Providers:OpenAI"));
builder.Services.Configure<ResilienceOptions>(builder.Configuration.GetSection("Resilience"));
builder.Services.Configure<CosmosOptions>(builder.Configuration.GetSection("Storage"));

builder.Services.AddSingleton(sp =>
{
    var cosmosOptions = sp.GetRequiredService<IOptions<CosmosOptions>>().Value;
    return new CosmosClient(cosmosOptions.CosmosConnectionString);
});
builder.Services.AddSingleton<IRequestLogStore, CosmosRequestLogStore>();

builder.Services.AddSingleton<ProviderCircuitBreakerRegistry>();

// Primary provider. Retry (outer) -> circuit breaker (middle) -> per-attempt timeout (inner).
// The circuit breaker is deliberately excluded from the retry's handled exceptions, so once it
// trips, calls fail fast instead of burning the retry budget on a provider that's already down.
builder.Services.AddHttpClient<ILlmProvider, AzureOpenAiProvider>((sp, client) =>
    {
        var options = sp.GetRequiredService<IOptions<AzureOpenAiOptions>>().Value;
        client.BaseAddress = new Uri(options.Endpoint);
        client.DefaultRequestHeaders.Add("api-key", options.ApiKey);
    })
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetRetryPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value))
    .AddPolicyHandler((sp, _) => sp.GetRequiredService<ProviderCircuitBreakerRegistry>().GetOrCreate("azure-openai"))
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetTimeoutPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value));

// Fallback provider (Phase 2). LlmProviderRouter tries providers in Priority order and falls
// back to this one when the primary's pipeline gives up.
builder.Services.AddHttpClient<ILlmProvider, OpenAiProvider>((sp, client) =>
    {
        var options = sp.GetRequiredService<IOptions<OpenAiOptions>>().Value;
        client.BaseAddress = new Uri(options.Endpoint);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
    })
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetRetryPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value))
    .AddPolicyHandler((sp, _) => sp.GetRequiredService<ProviderCircuitBreakerRegistry>().GetOrCreate("openai"))
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetTimeoutPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value));

builder.Services.AddTransient<LlmProviderRouter>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

using (var scope = app.Services.CreateScope())
{
    var requestLogStore = scope.ServiceProvider.GetRequiredService<IRequestLogStore>();
    await requestLogStore.InitializeAsync();

    // Eagerly create both breakers so /health reports every configured provider from the
    // first request onward, rather than only after that provider has taken traffic.
    var circuitBreakerRegistry = scope.ServiceProvider.GetRequiredService<ProviderCircuitBreakerRegistry>();
    circuitBreakerRegistry.GetOrCreate("azure-openai");
    circuitBreakerRegistry.GetOrCreate("openai");
}

app.MapPost("/v1/chat/completions", async (ChatCompletionRequest request, LlmProviderRouter router, IRequestLogStore logStore, CancellationToken cancellationToken) =>
{
    var stopwatch = Stopwatch.StartNew();
    try
    {
        var response = await router.CompleteAsync(request, cancellationToken);
        stopwatch.Stop();
        await logStore.LogAsync(RequestLogEntry.FromSuccess(request, response, stopwatch.ElapsedMilliseconds), cancellationToken);
        return Results.Ok(response);
    }
    catch (Exception ex)
    {
        stopwatch.Stop();
        await logStore.LogAsync(RequestLogEntry.FromFailure(request, ex, stopwatch.ElapsedMilliseconds), cancellationToken);
        return Results.Problem(detail: ex.Message, statusCode: StatusCodes.Status502BadGateway, title: "LLM provider call failed");
    }
});

app.MapGet("/v1/usage/{callerId}", async (string callerId, IRequestLogStore logStore, CancellationToken cancellationToken) =>
{
    var summary = await logStore.GetUsageAsync(callerId, DateTimeOffset.UtcNow.AddDays(-30), DateTimeOffset.UtcNow, cancellationToken);
    return Results.Ok(summary);
});

app.MapGet("/health", (ProviderCircuitBreakerRegistry circuitBreakerRegistry) => Results.Ok(new
{
    status = "healthy",
    timestampUtc = DateTimeOffset.UtcNow,
    circuitBreakers = circuitBreakerRegistry.GetAllStates()
}));

app.Run();
