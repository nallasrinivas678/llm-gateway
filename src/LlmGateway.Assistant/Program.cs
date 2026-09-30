using LlmGateway.Assistant.Auth;
using LlmGateway.Assistant.Connectors;
using LlmGateway.Assistant.Endpoints;
using LlmGateway.Assistant.Orchestrator;
using LlmGateway.Assistant.Providers;
using LlmGateway.Assistant.Tools;
using Microsoft.Extensions.Options;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.Configure<AnthropicOptions>(builder.Configuration.GetSection("Anthropic"));
builder.Services.Configure<GeminiOptions>(builder.Configuration.GetSection("Gemini"));
builder.Services.Configure<SupabaseOptions>(builder.Configuration.GetSection("Supabase"));
builder.Services.Configure<GoogleOAuthOptions>(builder.Configuration.GetSection("GoogleOAuth"));

var supabaseAuthOptions = new SupabaseAuthOptions();
builder.Configuration.GetSection("SupabaseAuth").Bind(supabaseAuthOptions);
builder.Services.AddSupabaseJwtBearer(supabaseAuthOptions);
builder.Services.AddAuthorization();

// Supabase Postgres access (conversations/messages/user_profiles/google_tokens/job_applications).
builder.Services.AddSingleton(sp =>
{
    var options = sp.GetRequiredService<IOptions<SupabaseOptions>>().Value;
    return NpgsqlDataSource.Create(options.ConnectionString);
});
builder.Services.AddScoped<ISupabaseDataService, SupabaseDataService>();

// Google OAuth + connectors (Calendar is real; Gmail/Docs are stubs - see their files).
builder.Services.AddHttpClient<IGoogleOAuthService, GoogleOAuthService>();
builder.Services.AddHttpClient<ICalendarConnector, CalendarConnector>();
builder.Services.AddHttpClient<IGmailConnector, GmailConnector>();
builder.Services.AddHttpClient<IDocsConnector, DocsConnector>();

// LLM provider - Anthropic or Gemini, selected via Llm:Provider (default Anthropic). Both
// implement this project's own tool-calling-aware ILlmProvider (Providers/ILlmProvider.cs),
// distinct from LlmGateway.Api's provider abstraction.
var llmProviderName = builder.Configuration.GetValue("Llm:Provider", "Anthropic");
if (string.Equals(llmProviderName, "Gemini", StringComparison.OrdinalIgnoreCase))
{
    builder.Services.AddHttpClient<ILlmProvider, GeminiProvider>((sp, client) =>
    {
        var options = sp.GetRequiredService<IOptions<GeminiOptions>>().Value;
        client.BaseAddress = new Uri(options.Endpoint);
    });
}
else
{
    builder.Services.AddHttpClient<ILlmProvider, AnthropicProvider>((sp, client) =>
    {
        var options = sp.GetRequiredService<IOptions<AnthropicOptions>>().Value;
        client.BaseAddress = new Uri(options.Endpoint);
        client.DefaultRequestHeaders.Add("anthropic-version", options.AnthropicVersion);
        client.DefaultRequestHeaders.Add("x-api-key", options.ApiKey);
    });
}

// Tools. CurrentUserContext is Scoped (set once per request in ChatController), so every tool
// that depends on it - directly or via a connector - is registered Scoped too, to avoid a
// singleton/scoped captive-dependency mismatch.
builder.Services.AddScoped<CurrentUserContext>();
builder.Services.AddScoped<ITool, ListUpcomingEventsTool>();
builder.Services.AddScoped<ITool, CreateCalendarEventTool>();
builder.Services.AddScoped<ITool, SendEmailTool>();
builder.Services.AddScoped<ITool, ReadDocumentTool>();
builder.Services.AddScoped<ITool, AppendToDocumentTool>();
builder.Services.AddScoped<ITool, CreateTaskTool>();
builder.Services.AddScoped<ITool, ListTasksTool>();
builder.Services.AddScoped<ITool, CompleteTaskTool>();
builder.Services.AddScoped<ITool, RescheduleTaskTool>();
builder.Services.AddHttpClient<ITool, WebSearchTool>();
builder.Services.AddScoped<ITool, DraftTailoredApplicationTool>();

builder.Services.AddScoped<IToolRegistry, ToolRegistry>();
builder.Services.AddScoped<ToolCallDispatcher>();
builder.Services.AddScoped<ChatOrchestrator>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseAuthentication();
app.UseAuthorization();

app.MapChatEndpoints();

app.MapGet("/health", () => Results.Ok(new { status = "healthy", timestampUtc = DateTimeOffset.UtcNow }));

app.Run();
