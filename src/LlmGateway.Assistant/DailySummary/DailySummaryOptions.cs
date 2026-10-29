namespace LlmGateway.Assistant.DailySummary;

public class DailySummaryOptions
{
    public int MaxEmailsPerCategory { get; set; } = 5;
    public int MaxTotalEmails { get; set; } = 15;
    public int MaxCalendarEvents { get; set; } = 10;
    public int LlmTimeoutSeconds { get; set; } = 25;
    public int LlmMaxRetries { get; set; } = 1;
}
