using LlmGateway.Assistant.Connectors;
using LlmGateway.Assistant.DailySummary;
using LlmGateway.Assistant.Models;
using LlmGateway.Assistant.Tests.Fakes;
using Microsoft.Extensions.Options;
using Xunit;

namespace LlmGateway.Assistant.Tests.DailySummary;

public class DailySummaryServiceTests
{
    private static IOptions<DailySummaryOptions> DefaultOptions(int llmMaxRetries = 1) =>
        Options.Create(new DailySummaryOptions
        {
            MaxEmailsPerCategory = 5,
            MaxTotalEmails = 15,
            MaxCalendarEvents = 10,
            LlmTimeoutSeconds = 25,
            LlmMaxRetries = llmMaxRetries
        });

    [Fact]
    public async Task BuildAsync_IncludesGmailAndCalendarDataInResponseAndPrompt()
    {
        var emails = new List<GmailMessageSummary>
        {
            new() { Id = "1", Category = "order", Subject = "Your order has shipped", From = "orders@shop.com", Snippet = "On its way", Date = DateTimeOffset.UtcNow }
        };
        var events = new List<CalendarEvent>
        {
            new() { Id = "e1", Summary = "Dentist appointment", Start = DateTimeOffset.UtcNow.AddHours(2), End = DateTimeOffset.UtcNow.AddHours(3) }
        };

        var gmail = new FakeGmailConnector(emails);
        var calendar = new FakeCalendarConnector(events);
        var llm = new FakeLlmProvider("Summary text");

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, new FakeDailySummaryCache(), DefaultOptions());

        var result = await service.BuildAsync(Guid.NewGuid());

        Assert.Equal("Summary text", result.Summary);
        Assert.Single(result.Emails);
        Assert.Equal("Your order has shipped", result.Emails[0].Subject);
        Assert.Single(result.Events);
        Assert.Equal("Dentist appointment", result.Events[0].Summary);

        Assert.Single(llm.ReceivedRequests);
        var prompt = llm.ReceivedRequests[0].Messages[0].Content;
        Assert.Contains("Your order has shipped", prompt);
        Assert.Contains("Dentist appointment", prompt);
        Assert.Empty(llm.ReceivedRequests[0].Tools);
    }

    [Fact]
    public async Task BuildAsync_WithNoEmailsOrEvents_StillCallsLlmAndReturnsResponse()
    {
        var gmail = new FakeGmailConnector();
        var calendar = new FakeCalendarConnector();
        var llm = new FakeLlmProvider("Nothing much today.");

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, new FakeDailySummaryCache(), DefaultOptions());

        var result = await service.BuildAsync(Guid.NewGuid());

        Assert.Equal("Nothing much today.", result.Summary);
        Assert.Empty(result.Emails);
        Assert.Empty(result.Events);
    }

    [Fact]
    public async Task BuildAsync_RetriesOnceAfterTransientLlmFailure_ThenSucceeds()
    {
        var gmail = new FakeGmailConnector();
        var calendar = new FakeCalendarConnector();
        var llm = new FakeLlmProvider("Recovered.", throwCount: 1);

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, new FakeDailySummaryCache(), DefaultOptions(llmMaxRetries: 1));

        var result = await service.BuildAsync(Guid.NewGuid());

        Assert.Equal("Recovered.", result.Summary);
        Assert.Equal(2, llm.ReceivedRequests.Count);
    }

    [Fact]
    public async Task BuildAsync_WhenLlmAlwaysFails_ThrowsAfterExhaustingRetries()
    {
        var gmail = new FakeGmailConnector();
        var calendar = new FakeCalendarConnector();
        var llm = new FakeLlmProvider(throwCount: int.MaxValue);

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, new FakeDailySummaryCache(), DefaultOptions(llmMaxRetries: 1));

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.BuildAsync(Guid.NewGuid()));
        Assert.Equal(2, llm.ReceivedRequests.Count); // initial attempt + 1 retry
    }

    [Fact]
    public async Task StreamAsync_YieldsStatusThenChunksThenDone_WithTheFullSummaryAssembled()
    {
        var emails = new List<GmailMessageSummary>
        {
            new() { Id = "1", Category = "order", Subject = "Your order has shipped", From = "orders@shop.com", Snippet = "On its way", Date = DateTimeOffset.UtcNow }
        };
        var events = new List<CalendarEvent>
        {
            new() { Id = "e1", Summary = "Dentist appointment", Start = DateTimeOffset.UtcNow.AddHours(2), End = DateTimeOffset.UtcNow.AddHours(3) }
        };

        var gmail = new FakeGmailConnector(emails);
        var calendar = new FakeCalendarConnector(events);
        var llm = new FakeLlmProvider("Here is your summary.");

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, new FakeDailySummaryCache(), DefaultOptions());

        var received = new List<DailySummaryStreamEvent>();
        await foreach (var streamEvent in service.StreamAsync(Guid.NewGuid()))
        {
            received.Add(streamEvent);
        }

        Assert.IsType<DailySummaryStreamEvent.Status>(received[0]);
        var chunks = received.OfType<DailySummaryStreamEvent.Chunk>().ToList();
        Assert.Single(chunks);
        Assert.Equal("Here is your summary.", chunks[0].Text);

        var done = Assert.IsType<DailySummaryStreamEvent.Done>(received[^1]);
        Assert.Equal("Here is your summary.", done.Result.Summary);
        Assert.Single(done.Result.Emails);
        Assert.Single(done.Result.Events);
    }

    [Fact]
    public async Task BuildAsync_OnCacheHit_ReturnsCachedResponseWithoutCallingConnectorsOrLlm()
    {
        var gmail = new FakeGmailConnector();
        var calendar = new FakeCalendarConnector();
        var llm = new FakeLlmProvider("Should not be called.");
        var cache = new FakeDailySummaryCache();
        var userId = Guid.NewGuid();
        var cachedDto = new DailySummaryResponseDto("Cached summary.", new List<EmailHighlightDto>(), new List<CalendarHighlightDto>(), DateTimeOffset.UtcNow);
        await cache.SetAsync(userId, cachedDto);

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, cache, DefaultOptions());

        var result = await service.BuildAsync(userId);

        Assert.Equal("Cached summary.", result.Summary);
        Assert.Empty(gmail.ReceivedUserIds);
        Assert.Empty(calendar.ReceivedUserIds);
        Assert.Empty(llm.ReceivedRequests);
    }

    [Fact]
    public async Task BuildAsync_OnCacheMiss_PopulatesCacheAfterGenerating()
    {
        var gmail = new FakeGmailConnector();
        var calendar = new FakeCalendarConnector();
        var llm = new FakeLlmProvider("Freshly generated.");
        var cache = new FakeDailySummaryCache();
        var userId = Guid.NewGuid();

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, cache, DefaultOptions());

        await service.BuildAsync(userId);

        Assert.Equal(1, cache.SetCallCount);
        var cached = await cache.GetAsync(userId);
        Assert.Equal("Freshly generated.", cached!.Summary);
    }

    [Fact]
    public async Task StreamAsync_OnCacheHit_YieldsOneChunkThenDone_WithoutStatusEventsOrLlmCall()
    {
        var gmail = new FakeGmailConnector();
        var calendar = new FakeCalendarConnector();
        var llm = new FakeLlmProvider("Should not be called.");
        var cache = new FakeDailySummaryCache();
        var userId = Guid.NewGuid();
        var cachedDto = new DailySummaryResponseDto("Cached summary.", new List<EmailHighlightDto>(), new List<CalendarHighlightDto>(), DateTimeOffset.UtcNow);
        await cache.SetAsync(userId, cachedDto);

        var service = new LlmGateway.Assistant.DailySummary.DailySummaryService(gmail, calendar, llm, cache, DefaultOptions());

        var received = new List<DailySummaryStreamEvent>();
        await foreach (var streamEvent in service.StreamAsync(userId))
        {
            received.Add(streamEvent);
        }

        Assert.Equal(2, received.Count);
        var chunk = Assert.IsType<DailySummaryStreamEvent.Chunk>(received[0]);
        Assert.Equal("Cached summary.", chunk.Text);
        Assert.IsType<DailySummaryStreamEvent.Done>(received[1]);
        Assert.Empty(llm.ReceivedRequests);
    }
}
