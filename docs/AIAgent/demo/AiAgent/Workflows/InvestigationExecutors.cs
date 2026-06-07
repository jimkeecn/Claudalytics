using AiAgent.Tools;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;

namespace AiAgent.Workflows
{
    [SendsMessage(typeof(ProbeJob))]
    public sealed partial class PlanExecutor() : Executor<InvestigationRequest>("plan")
    {
        [MessageHandler]
        public override async ValueTask HandleAsync(
            InvestigationRequest request, IWorkflowContext context, CancellationToken cancellationToken = default)
        {
            var days = Math.Clamp(request.Days, 1, 90);

            await context.AddEventAsync(
                new InvestigationProgressEvent($"Planning {days}-day investigation: 3 probes."),
                cancellationToken);

            await context.QueueStateUpdateAsync("days", days, scopeName: "investigation", cancellationToken);

            ProbeJob[] jobs =
                [
                    new(0, "cost-trend", $"""
                        SELECT toDate(Timestamp) AS day,
                               round(sum(toFloat64OrZero(LogAttributes['cost_usd'])), 2) AS cost_usd
                        FROM otel_logs
                        WHERE LogAttributes['event.name'] = 'api_request'
                          AND Timestamp >= now() - INTERVAL {days} DAY
                        GROUP BY day ORDER BY day
                        """, days),
                    new(1, "tool-failures", $"""
                        SELECT LogAttributes['tool_name'] AS tool_name, count() AS calls,
                               countIf(LogAttributes['success'] != 'true') AS failures
                        FROM otel_logs
                        WHERE LogAttributes['event.name'] = 'tool_result'
                          AND Timestamp >= now() - INTERVAL {days} DAY
                        GROUP BY tool_name ORDER BY failures DESC LIMIT 10
                        """, days),
                    new(2, "security-events", $"""
                        SELECT pattern_category, count() AS exposures
                        FROM credential_exposures
                        WHERE timestamp >= now() - INTERVAL {days} DAY
                        GROUP BY pattern_category ORDER BY exposures DESC
                        """, days),
                ];

            foreach (var job in jobs)
                await context.SendMessageAsync(job, cancellationToken: cancellationToken);
        }
    }

    [SendsMessage(typeof(ProbeResult))]
    public sealed partial class ProbeExecutor(string id, ClickHouseClient clickHouse) : Executor<ProbeJob>(id)
    {
        [MessageHandler]
        public override async ValueTask HandleAsync(
            ProbeJob job, IWorkflowContext context, CancellationToken cancellationToken = default)
        {
            string rows;
            await context.AddEventAsync(
                    new InvestigationProgressEvent($"Probe '{job.Name}' running."),
                    cancellationToken);

            try
            {
                
                rows = await clickHouse.QueryAsync(job.Sql, cancellationToken);
            }
            catch (Exception ex)
            {
                rows = $"QUERY FAILED: {ex.Message}";
            }
            await context.QueueStateUpdateAsync($"probe:{job.Name}", rows, scopeName: "investigation", cancellationToken);
            var hasData = !rows.StartsWith("QUERY FAILED") && rows != "(no rows)" && rows.Any(char.IsDigit);
            await context.SendMessageAsync(new ProbeResult(job.Name, rows, hasData), cancellationToken: cancellationToken);
        }
    }

    [YieldsOutput(typeof(string))]
    public sealed partial class CollectorExecutor() : Executor<ProbeResult>("collector")
    {
        private readonly List<ProbeResult> accumulated = [];
        private const int ExpectedProbes = 3;
        [MessageHandler]
        public override async ValueTask HandleAsync(
           ProbeResult result, IWorkflowContext context, CancellationToken cancellationToken = default)
            {
                accumulated.Add(result);

                if (accumulated.Count < ExpectedProbes)
                    return; // wait for the remaining probes

                var combined = string.Join("\n\n", accumulated.Select(probe =>
                    $"=== {probe.Name} ===\n{probe.Rows}"));

                await context.YieldOutputAsync(combined, cancellationToken);
            }
    }

    [SendsMessage(typeof(Findings))]
    [SendsMessage(typeof(DeepDiveRequest))]
    public sealed partial class ValidatorExecutor() : Executor<ProbeResult>("validator")
    {
        private const int ExpectedProbes = 3;
        private readonly List<ProbeResult> _accumulated = [];

        [MessageHandler]
        public override async ValueTask HandleAsync(
            ProbeResult result, IWorkflowContext context, CancellationToken cancellationToken = default)
        {
            _accumulated.Add(result);
            if (_accumulated.Count < ExpectedProbes) return;
            var notes = _accumulated
               .Where(probe => !probe.HasData)
               .Select(probe => $"Probe '{probe.Name}' returned no usable numbers — finding rejected, not interpreted.")
               .ToList();

            var findings = new Findings(
                Days: 0,  
                Results: [.. _accumulated],
                CostSpike: false,
                ValidationNotes: notes);

            await context.AddEventAsync(
                new InvestigationProgressEvent("Validation complete — forwarding findings."), cancellationToken);

            await context.SendMessageAsync(findings, cancellationToken: cancellationToken);

        }
    }

    [SendsMessage(typeof(Findings))]
    public sealed partial class DeepDiveExecutor() : Executor<DeepDiveDecision>("deepdive")
    {
        [MessageHandler]
        public override async ValueTask HandleAsync(
            DeepDiveDecision decision, IWorkflowContext context, CancellationToken cancellationToken = default)
        {
            // Read findings stashed by the validator; null-coalesce to an empty fallback.
            var findings = await context.ReadStateAsync<Findings>(
                "findings", scopeName: "investigation", cancellationToken)
                ?? new Findings(0, [], false, ["Findings state was missing."]);

            if (!decision.Approve)
            {
                findings.ValidationNotes.Add("A cost spike was detected but the deep dive was declined by the user.");
                await context.SendMessageAsync(findings, cancellationToken: cancellationToken);
                return;
            }
        }
    }

    [YieldsOutput(typeof(string))]
    public sealed partial class SynthesisExecutor(AIAgent writer) : Executor<Findings>("synthesis")
    {
        [MessageHandler]
        public override async ValueTask HandleAsync(
            Findings findings, IWorkflowContext context, CancellationToken cancellationToken = default)
        {
            await context.AddEventAsync(
                new InvestigationProgressEvent("Synthesizing the report."), cancellationToken);

            var probesText = string.Join("\n\n",
                findings.Results.Select(probe => $"## {probe.Name}\n{probe.Rows}"));
            var notesText = findings.ValidationNotes.Count == 0
                ? "(none)"
                : string.Join("\n", findings.ValidationNotes);

            var response = await writer.RunAsync($"""
                Write a short markdown investigation report over the last {findings.Days} days of
                Claude Code telemetry. Cost spike detected: {findings.CostSpike}.

                Probe data (TSV):
                {probesText}

                Validator notes (mention them honestly):
                {notesText}

                Shape: headline numbers, findings, then 1-3 recommendations. Use only the
                numbers in the data above.
                """, cancellationToken: cancellationToken);

            await context.YieldOutputAsync(response.Text, cancellationToken);
        }
    }
}
