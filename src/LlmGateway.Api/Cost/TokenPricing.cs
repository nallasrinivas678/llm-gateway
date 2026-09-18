namespace LlmGateway.Api.Cost;

public static class TokenPricing
{
    // Approximate USD price per 1,000 tokens. Extend as more models/providers are onboarded; unknown models cost $0.
    private static readonly Dictionary<string, (decimal PromptPer1K, decimal CompletionPer1K)> Prices = new(StringComparer.OrdinalIgnoreCase)
    {
        ["gpt-4o-mini"] = (0.00015m, 0.0006m),
        ["gpt-4o"] = (0.0025m, 0.01m)
    };

    public static decimal Calculate(string model, int promptTokens, int completionTokens)
    {
        if (!Prices.TryGetValue(model, out var price))
        {
            return 0m;
        }

        return (promptTokens / 1000m * price.PromptPer1K) + (completionTokens / 1000m * price.CompletionPer1K);
    }
}
