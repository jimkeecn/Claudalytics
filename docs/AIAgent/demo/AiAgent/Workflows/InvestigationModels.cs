using Microsoft.Agents.AI.Workflows;
namespace AiAgent.Workflows
{
    public sealed record InvestigationRequest(int Days);

    public sealed record ProbeJob(int Slot, string Name, string Sql, int Days);

    public sealed record ProbeResult(string Name, string Rows, bool HasData);

    public sealed class InvestigationProgressEvent(string message) : WorkflowEvent(message)
    {
        public string Message { get; } = message;
    }

    public sealed record Findings(
        int Days, 
        List<ProbeResult> Results, 
        bool CostSpike, 
        List<string> ValidationNotes);

    public sealed record DeepDiveRequest(string Reason);

    public sealed record DeepDiveDecision(bool Approve);
}
