using AiAgent.Tools;
using Anthropic;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Extensions.AI;

namespace AiAgent.Agents;

public static class ReportWorkflow
{
    public static AIAgent Create(IConfiguration config, SchemaTools tools, AnalysisTools analysis)
    {
        var apiKey = config["ANTHROPIC_API_KEY"]
            ?? throw new InvalidOperationException("ANTHROPIC_API_KEY is not set.");

        IAnthropicClient client = new AnthropicClient { ApiKey = apiKey };

        var analystModel = ModelTiers.Analyst(config);
        var reasoningModel = ModelTiers.Reasoning(config);

        List<AITool> sqlTools =
        [
            AIFunctionFactory.Create(tools.GetSchema),
            AIFunctionFactory.Create(tools.RunSql),
            AIFunctionFactory.Create(tools.ListProjects),
            AIFunctionFactory.Create(analysis.CostBreakdown),
            AIFunctionFactory.Create(analysis.SessionDeepDive),
        ];

        var costAnalyst = CreateAnalyst(client, analystModel, "CostAnalyst", AnalystInstructions.Cost, sqlTools);
        var securityAnalyst = CreateAnalyst(client, analystModel, "SecurityAnalyst", AnalystInstructions.Security, sqlTools);
        var toolingAnalyst = CreateAnalyst(client, analystModel, "ToolingAnalyst", AnalystInstructions.Tooling, sqlTools);
        var summarizer = CreateAnalyst(client, reasoningModel, "Summarizer", AnalystInstructions.Summarizer, tools: null);

        var analystsWorkflow = AgentWorkflowBuilder.BuildConcurrent(
            [costAnalyst, securityAnalyst, toolingAnalyst]);

        var analystsAgent = analystsWorkflow.AsAIAgent(
            name: "Analysts",
            description: "Runs cost, security and tooling analysts concurrently.");

        var reportWorkflow = AgentWorkflowBuilder.BuildSequential([analystsAgent, summarizer]);

        return reportWorkflow.AsAIAgent(
            name: "telemetry-report",
            description: "Produces a Claude Code telemetry report for the requested window.");
    }

    private static AIAgent CreateAnalyst(
        IAnthropicClient client, string model, string name, string instructions, List<AITool>? tools)
    {
        var agent = client.AsAIAgent(model: model, instructions: instructions, name: name, tools: tools);

        return agent.AsBuilder()
            .UseOpenTelemetry(AgentFactory.OtelSourceName)
            .Build();
    }
}