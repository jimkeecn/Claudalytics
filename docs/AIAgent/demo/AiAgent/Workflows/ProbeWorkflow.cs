using AiAgent.Tools;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AiAgent.Workflows;
public static class ProbeWorkflow
{
    public static Workflow Build(ClickHouseClient clickHouse)
    {
        var plan = new PlanExecutor();
        ProbeExecutor[] probes =
        [
            new("probe-0", clickHouse),
            new("probe-1", clickHouse),
            new("probe-2", clickHouse),
        ];
        var collector = new CollectorExecutor();

        var builder = new WorkflowBuilder(plan);

        builder.AddFanOutEdge<ProbeJob>(plan, probes.Select(p => (ExecutorBinding)p),
            (job, targetCount) => [(job?.Slot ?? 0) % targetCount]);

        builder.AddFanInBarrierEdge(probes.Select(p => (ExecutorBinding)p), collector);
        return builder.WithOutputFrom(collector).Build();
    }
}