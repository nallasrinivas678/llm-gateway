using System.Diagnostics;
using System.Net.Http.Headers;
using LlmGateway.Api.Caching;
using LlmGateway.Api.Cost;
using LlmGateway.Api.Models;
using LlmGateway.Api.Providers;
using LlmGateway.Api.Resilience;
using Microsoft.Azure.Cosmos;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.Configure<AzureOpenAiOptions>(builder.Configuration.GetSection("Providers:AzureOpenAI"));
builder.Services.Configure<OpenAiOptions>(builder.Configuration.GetSection("Providers:OpenAI"));
builder.Services.Configure<OllamaOptions>(builder.Configuration.GetSection("Providers:Ollama"));
builder.Services.Configure<ResilienceOptions>(builder.Configuration.GetSection("Resilience"));
builder.Services.Configure<CosmosOptions>(builder.Configuration.GetSection("Storage"));
builder.Services.Configure<CacheOptions>(builder.Configuration.GetSection("Cache"));

var requestLoggingEnabled = builder.Configuration.GetValue("Storage:RequestLoggingEnabled", true);

if (requestLoggingEnabled)
{
    builder.Services.AddSingleton(sp =>
    {
        var cosmosOptions = sp.GetRequiredService<IOptions<CosmosOptions>>().Value;
        var clientOptions = new CosmosClientOptions();

        if (builder.Environment.IsDevelopment())
        {
            // Recommended CosmosClientOptions for the local Cosmos DB Emulator: accept its self-signed
            // cert, skip multi-region discovery (single-region only), and avoid its direct-mode replica
            // ports (10250-10255), which can collide with Windows' dynamically reserved port ranges.
            // Local dev only - never do this against a real Cosmos account.
            clientOptions.ConnectionMode = ConnectionMode.Gateway;
            clientOptions.LimitToEndpoint = true;
            clientOptions.HttpClientFactory = () =>
            {
                var httpClient = new HttpClient(new HttpClientHandler
                {
                    ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
                });
                httpClient.DefaultRequestVersion = System.Net.HttpVersion.Version11;
                httpClient.DefaultVersionPolicy = System.Net.Http.HttpVersionPolicy.RequestVersionExact;
                return httpClient;
            };
        }

        return new CosmosClient(cosmosOptions.CosmosConnectionString, clientOptions);
    });
    builder.Services.AddSingleton<IRequestLogStore, CosmosRequestLogStore>();
}
else
{
    builder.Services.AddSingleton<IRequestLogStore, NullRequestLogStore>();
}

var cachingEnabled = builder.Configuration.GetValue("Cache:Enabled", true);

if (cachingEnabled)
{
    builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
    {
        var cacheOptions = sp.GetRequiredService<IOptions<CacheOptions>>().Value;
        var configurationOptions = ConfigurationOptions.Parse(cacheOptions.RedisConnectionString);

        // Don't let a briefly-unreachable Redis block app startup or throw on connect - StackExchange.Redis
        // retries in the background, and RedisCacheStore already degrades to "no caching" per-call on failure.
        configurationOptions.AbortOnConnectFail = false;
        return ConnectionMultiplexer.Connect(configurationOptions);
    });
    builder.Services.AddSingleton<ICacheStore, RedisCacheStore>();
}
else
{
    builder.Services.AddSingleton<ICacheStore, NullCacheStore>();
}

builder.Services.AddSingleton<ProviderCircuitBreakerRegistry>();

// Cloud provider. LlmProviderRouter tries providers in Priority order (see each provider's
// Options class) - Ollama defaults to Priority 0 (tried first, no credentials needed for local
// dev); bump these below Ollama's once real Azure OpenAI/OpenAI keys are configured, to make
// cloud providers primary again. Retry (outer) -> circuit breaker (middle) -> per-attempt
// timeout (inner). The circuit breaker is deliberately excluded from the retry's handled
// exceptions, so once it trips, calls fail fast instead of burning the retry budget on a
// provider that's already down.
builder.Services.AddHttpClient<ILlmProvider, AzureOpenAiProvider>((sp, client) =>
    {
        var options = sp.GetRequiredService<IOptions<AzureOpenAiOptions>>().Value;

        // An unset Endpoint means this provider isn't configured. Leave BaseAddress unset rather
        // than throwing here - throwing during DI construction would crash IEnumerable<ILlmProvider>
        // resolution entirely, taking every provider down with it (including ones that ARE
        // configured) before LlmProviderRouter even gets a chance to try a fallback. Left unset,
        // AzureOpenAiProvider.CompleteAsync fails with a clear, catchable error instead.
        if (!string.IsNullOrWhiteSpace(options.Endpoint))
        {
            client.BaseAddress = new Uri(options.Endpoint);
        }

        client.DefaultRequestHeaders.Add("api-key", options.ApiKey);
    })
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetRetryPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value))
    .AddPolicyHandler((sp, _) => sp.GetRequiredService<ProviderCircuitBreakerRegistry>().GetOrCreate("azure-openai"))
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetTimeoutPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value));

// Cloud fallback provider (Phase 2).
builder.Services.AddHttpClient<ILlmProvider, OpenAiProvider>((sp, client) =>
    {
        var options = sp.GetRequiredService<IOptions<OpenAiOptions>>().Value;

        if (!string.IsNullOrWhiteSpace(options.Endpoint))
        {
            client.BaseAddress = new Uri(options.Endpoint);
        }

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", options.ApiKey);
    })
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetRetryPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value))
    .AddPolicyHandler((sp, _) => sp.GetRequiredService<ProviderCircuitBreakerRegistry>().GetOrCreate("openai"))
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetTimeoutPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value));

// Local model via Ollama. No API key required - default primary for local dev (see
// OllamaOptions.Priority).
builder.Services.AddHttpClient<ILlmProvider, OllamaProvider>((sp, client) =>
    {
        var options = sp.GetRequiredService<IOptions<OllamaOptions>>().Value;

        if (!string.IsNullOrWhiteSpace(options.Endpoint))
        {
            client.BaseAddress = new Uri(options.Endpoint);
        }
    })
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetRetryPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value))
    .AddPolicyHandler((sp, _) => sp.GetRequiredService<ProviderCircuitBreakerRegistry>().GetOrCreate("ollama"))
    .AddPolicyHandler((sp, _) => ResiliencePolicies.GetTimeoutPolicy(sp.GetRequiredService<IOptions<ResilienceOptions>>().Value));

builder.Services.AddTransient<LlmProviderRouter>();
builder.Services.AddTransient<CachedChatCompletionService>();

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

    // Eagerly create every breaker so /health reports all configured providers from the
    // first request onward, rather than only after that provider has taken traffic.
    var circuitBreakerRegistry = scope.ServiceProvider.GetRequiredService<ProviderCircuitBreakerRegistry>();
    circuitBreakerRegistry.GetOrCreate("azure-openai");
    circuitBreakerRegistry.GetOrCreate("openai");
    circuitBreakerRegistry.GetOrCreate("ollama");
}

app.MapPost("/v1/chat/completions", async (ChatCompletionRequest request, CachedChatCompletionService chatService, IRequestLogStore logStore, CancellationToken cancellationToken) =>
{
    var stopwatch = Stopwatch.StartNew();
    try
    {
        var response = await chatService.CompleteAsync(request, cancellationToken);
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
