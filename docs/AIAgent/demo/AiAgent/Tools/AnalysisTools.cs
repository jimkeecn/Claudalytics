using System.ComponentModel;

namespace AiAgent.Tools;

public sealed class AnalysisTools(ClickHouseClient clickHouse)
{
    [Description("Cost breakdown between two dates, grouped by model, project, session or day. Optionally restricted to one project. Returns cost and token sums per group, highest cost first.")]
    public async Task<string> CostBreakdown(
        [Description("Window start, ClickHouse-parseable, e.g. '2026-06-01' or 'now() - INTERVAL 7 DAY'. Quoted literals only when a date string.")] string start,
        [Description("Window end, e.g. 'now()'.")] string end,
        [Description("Grouping: one of model, project, session, day.")] string groupBy,
        [Description("Optional: restrict to one project name (exact project_name). Empty = all projects.")] string? project = null)
    {
        var groupExpr = groupBy.Trim().ToLowerInvariant() switch
        {
            "model" => "LogAttributes['model']",
            "project" => "ResourceAttributes['project.name']",
            "session" => "LogAttributes['session.id']",
            "day" => "toDate(Timestamp)",
            _ => null,
        };
        if (groupExpr is null)
            return "INVALID group_by: use model, project, session or day.";

        var projectFilter = string.IsNullOrWhiteSpace(project)
            ? ""
            : $"\n              AND ResourceAttributes['project.name'] = '{project.Replace("'", "''")}'";

        var sql = $"""
            SELECT {groupExpr} AS grp,
                   round(sum(toFloat64OrZero(LogAttributes['cost_usd'])), 4) AS cost_usd,
                   sum(toUInt64OrZero(LogAttributes['input_tokens'])) AS input_tokens,
                   sum(toUInt64OrZero(LogAttributes['output_tokens'])) AS output_tokens,
                   sum(toUInt64OrZero(LogAttributes['cache_read_tokens'])) AS cache_read_tokens,
                   count() AS api_requests
            FROM otel_logs
            WHERE LogAttributes['event.name'] = 'api_request'
              AND Timestamp >= {Expr(start)} AND Timestamp < {Expr(end)}{projectFilter}
            GROUP BY grp ORDER BY cost_usd DESC LIMIT 50
            """;
        return await RunValidated(sql);
    }

    [Description("Deep dive into one session: totals (cost, tokens, duration), tool usage, file mutations, blocked tools and visited sites.")]
    public async Task<string> SessionDeepDive(
    [Description("The session_id to analyze.")] string sessionId)
    {
        var id = sessionId.Replace("'", "''");

        var totals = await RunValidated($"""
            SELECT min(Timestamp) AS first_event, max(Timestamp) AS last_event,
                   round(sum(toFloat64OrZero(LogAttributes['cost_usd'])), 4) AS cost_usd,
                   sum(toUInt64OrZero(LogAttributes['input_tokens'])) AS input_tokens,
                   sum(toUInt64OrZero(LogAttributes['output_tokens'])) AS output_tokens,
                   countIf(LogAttributes['event.name'] = 'api_request') AS api_requests
            FROM otel_logs
            WHERE LogAttributes['session.id'] = '{id}' AND Timestamp >= now() - INTERVAL 90 DAY
            """);

        var tools = await RunValidated($"""
            SELECT LogAttributes['tool_name'] AS tool, count() AS calls,
                   countIf(LogAttributes['success'] = 'true') AS successes
            FROM otel_logs
            WHERE LogAttributes['event.name'] = 'tool_result'
              AND LogAttributes['session.id'] = '{id}' AND Timestamp >= now() - INTERVAL 90 DAY
            GROUP BY tool ORDER BY calls DESC LIMIT 20
            """);

        var mutations = await RunValidated(
            $"SELECT action, count() AS files FROM file_mutations WHERE session_id = '{id}' GROUP BY action ORDER BY files DESC LIMIT 10");

        var blocked = await RunValidated(
            $"SELECT tool_name, count() AS blocked FROM blocked_tools FINAL WHERE session_id = '{id}' AND completed = 0 GROUP BY tool_name LIMIT 10");

        var sites = await RunValidated(
            $"SELECT domain, count() AS visits FROM websites_visited WHERE session_id = '{id}' GROUP BY domain ORDER BY visits DESC LIMIT 10");

        return $"## Totals\n{totals}\n\n## Tool usage\n{tools}\n\n## File mutations\n{mutations}\n\n## Blocked tools\n{blocked}\n\n## Websites visited\n{sites}";
    }

    private async Task<string> RunValidated(string sql)
    {
        try
        {
            return await clickHouse.QueryAsync(SqlValidator.Validate(sql));
        }
        catch (Exception ex)
        {
            return $"QUERY FAILED: {ex.Message}";
        }
    }

    private static string Expr(string value)
    {
        var trimmed = value.Trim().Trim('\'');
        return System.Text.RegularExpressions.Regex.IsMatch(trimmed, @"^[\d\-: ]+$")
            ? $"'{trimmed}'"
            : System.Text.RegularExpressions.Regex.IsMatch(trimmed, @"^(now\(\)|today\(\)|yesterday\(\))(\s*[-+]\s*INTERVAL\s+\d+\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH))?$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                ? trimmed
                : throw new ArgumentException($"'{value}' is not a date literal or a simple now()/today() expression.");
    }
}