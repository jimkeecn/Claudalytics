using Microsoft.Agents.AI;

namespace AiAgent.Agents;

public static class ReportRunner
{
    public static async Task<(string Report, List<string> AgentsInvolved)> RunAsync(
        AIAgent reportAgent, string window, CancellationToken ct)
    {
        var response = await reportAgent.RunAsync(
            $"Produce the weekly report for {window}.", cancellationToken: ct);

        var lastMessage = response.Messages.LastOrDefault(m => !string.IsNullOrWhiteSpace(m.Text));
        var agentsInvolved = response.Messages
            .Select(m => m.AuthorName)
            .Where(author => !string.IsNullOrEmpty(author))
            .Distinct()
            .Select(author => author!)
            .ToList();

        return (lastMessage?.Text ?? response.Text, agentsInvolved);
    }
}