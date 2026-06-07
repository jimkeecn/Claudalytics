using AiAgent.Agents;
using AiAgent.Tools;
using Anthropic;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AiAgent.Workflows;

public class InvestigationWorkflow
{
    public static Workflow Build(IConfiguration config, ClickHouseClient clickHouse)
    {
        var apiKey = config["ANTHROPIC_API_KEY"]
            ?? throw new InvalidOperationException("ANTHROPIC_API_KEY is not set.");

        IAnthropicClient client = new AnthropicClient { ApiKey = apiKey };
        var writer = client.AsAIAgent(
            model: ModelTiers.Analyst(config),
            instructions: Instructions.Writer,
            name: "InvestigationWriter");

        var plan = new PlanExecutor();

        ProbeExecutor[] probes =
        [
            new("probe-0", clickHouse),
            new("probe-1", clickHouse),
            new("probe-2", clickHouse),
        ];

        var validator = new ValidatorExecutor();
        var deepDive = new DeepDiveExecutor();
        var synthesis = new SynthesisExecutor(writer);

        var builder = new WorkflowBuilder(plan);

        builder.AddFanOutEdge<ProbeJob>(plan, probes.Select(p => (ExecutorBinding)p),
            (job, targetCount) => [(job?.Slot ?? 0) % targetCount]);

        builder.AddFanInBarrierEdge(probes.Select(p => (ExecutorBinding)p), validator);

        builder.AddEdge<Findings>(validator, synthesis, _ => true);
        builder.AddEdge<DeepDiveRequest>(validator, deepDive, _ => true);
        builder.AddEdge(deepDive, synthesis);

        return builder.WithOutputFrom(synthesis).Build();
    }
}
