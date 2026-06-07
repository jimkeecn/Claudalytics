using AiAgent.Orchestration;
using Anthropic;
using Microsoft.Agents.AI;

namespace AiAgent.Agents;

public static class Router
{
    public static AIAgent Create(IConfiguration config, MenuRegistry menu, ILoggerFactory loggerFactory)
    {
        var apiKey = config["ANTHROPIC_API_KEY"]
         ?? throw new InvalidOperationException("ANTHROPIC_API_KEY is not set.");

        IAnthropicClient client = new AnthropicClient { ApiKey = apiKey };

        var instructions = $"""
            You are the router for the Claudalytics copilot. Classify each user message
            into exactly one intent:

            - "dispatch": the message clearly asks to run ONE of these catalog items.
              Set targetId to the item id and extract parameters (e.g. a time window)
              from the message into parameters. Catalog:
            {menu.CatalogForPrompt()}
            - "menu": the user asks what the copilot can do, what actions/reports are
              available, or for help/options.
            - "chat": everything else — ad-hoc data questions, follow-ups, analysis
              requests that do not name a catalog item. When in doubt, choose "chat".

            Output only the structured decision. Never answer the question yourself.
            """;

        var agent = client.AsAIAgent(
            model: ModelTiers.Light(config),
            instructions: instructions,
            name: "router",
            description: "Classifies each turn into chat | menu | dispatch.");

        return agent.AsBuilder()
            .UseOpenTelemetry(AgentFactory.OtelSourceName)
            .Build();
    }
}