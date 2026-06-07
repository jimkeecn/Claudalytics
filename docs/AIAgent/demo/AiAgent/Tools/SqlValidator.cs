using System.Text.RegularExpressions;

namespace AiAgent.Tools;

public static partial class SqlValidator
{
    private const int DefaultLimit = 100;

    [GeneratedRegex(@"^\s*(SELECT|WITH)\b", RegexOptions.IgnoreCase)]
    private static partial Regex SelectOrWith();

    [GeneratedRegex(@"\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|RENAME|TRUNCATE|ATTACH|DETACH|OPTIMIZE|GRANT|REVOKE|KILL|SYSTEM|FORMAT)\b|\bINTO\s+OUTFILE\b", RegexOptions.IgnoreCase)]
    private static partial Regex DeniedKeywords();

    [GeneratedRegex(@"\bLIMIT\s+\d", RegexOptions.IgnoreCase)]
    private static partial Regex HasLimit();

    [GeneratedRegex(@"\botel_logs\b", RegexOptions.IgnoreCase)]
    private static partial Regex TargetsOtelLogs();

    public static string Validate(string query, bool requireTimeFilter = true)
    {
        var sql = query.Trim().TrimEnd(';').Trim();

        if (sql.Contains(';'))
            throw new ArgumentException("Only a single SQL statement is allowed.");

        if (!SelectOrWith().IsMatch(sql))
            throw new ArgumentException("Only SELECT (or WITH ... SELECT) queries are allowed.");

        var denied = DeniedKeywords().Match(sql);
        if (denied.Success)
            throw new ArgumentException($"Keyword '{denied.Value}' is not allowed. This tool is read-only; FORMAT is appended automatically.");

        if (requireTimeFilter && TargetsOtelLogs().IsMatch(sql) && !sql.Contains("Timestamp", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Queries against otel_logs must filter on Timestamp (it is a large table). Add e.g. WHERE Timestamp >= now() - INTERVAL 1 DAY.");

        if (!HasLimit().IsMatch(sql))
            sql += $" LIMIT {DefaultLimit}";

        return sql;
    }
}
