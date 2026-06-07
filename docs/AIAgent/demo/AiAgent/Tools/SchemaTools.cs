using System.ComponentModel;
using AiAgent.Agents;

namespace AiAgent.Tools
{
    public class SchemaTools(ClickHouseClient clickHouse)
    {
        [Description("Returns the full ClickHouse schema reference: tables, columns, attribute extraction idioms and example queries.")]
        public string GetSchema() => Instructions.SchemaDoc;

        [Description("Executes a read-only SELECT query against the claudalytics ClickHouse database and returns rows as tab-separated text. Single statement only; otel_logs queries must filter on Timestamp; a LIMIT is added if missing.")]
        public async Task<string> RunSql([Description("The SELECT (or WITH ... SELECT) query to execute.")] string query)
        {
            try
            {
                var sql = SqlValidator.Validate(query);
                return await clickHouse.QueryAsync(sql);
            }
            catch (Exception ex)
            {
                return $"QUERY FAILED: {ex.Message}";
            }
        }

        [Description("Lists all project names that have telemetry data, with session counts.")]
        public async Task<string> ListProjects()
        {
            try
            {
                return await clickHouse.QueryAsync(
                    "SELECT project_name, count() AS sessions, max(last_event_at) AS latest_activity " +
                    "FROM sessions FINAL GROUP BY project_name ORDER BY latest_activity DESC LIMIT 50");
            }
            catch (Exception ex)
            {
                return $"QUERY FAILED: {ex.Message}";
            }
        }

        [Description("Lists the most recent sessions, optionally filtered to one project.")]
        public async Task<string> ListRecentSessions(
        [Description("Optional project name to filter by; empty for all projects.")] string project = "")
        {
            try
            {
                var filter = string.IsNullOrWhiteSpace(project)
                    ? ""
                    : $"WHERE project_name = '{project.Replace("'", "''")}' ";
                return await clickHouse.QueryAsync(
                    "SELECT session_id, project_name, started_at, last_event_at, otel_event_count " +
                    $"FROM sessions FINAL {filter}ORDER BY last_event_at DESC LIMIT 20");
            }
            catch (Exception ex)
            {
                return $"QUERY FAILED: {ex.Message}";
            }
        }

        [Description("Executes a read-only SELECT WITHOUT the otel_logs time-filter requirement. "
           + "Use ONLY when a full-table scan is genuinely needed. "
           + "Every call requires explicit human approval before it runs.")]
        public async Task<string> RunUnboundedSql(
        [Description("The SELECT (or WITH ... SELECT) query to execute, "
                   + "may scan otel_logs without a Timestamp filter.")] string query)
            {
                try
                {
                    var sql = SqlValidator.Validate(query, requireTimeFilter: false);
                    return await clickHouse.QueryAsync(sql);
                }
                catch (Exception ex)
                {
                    return $"QUERY FAILED: {ex.Message}";
                }
            }
    }
}
