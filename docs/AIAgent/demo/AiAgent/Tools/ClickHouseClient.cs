using Microsoft.Extensions.Configuration;

namespace AiAgent.Tools
{
    public sealed class ClickHouseClient(HttpClient http, IConfiguration config)
    {
        private readonly string _baseUrl = config["CLICKHOUSE_URL"] ?? "http://localhost:8123";
        private readonly string _user = config["CLICKHOUSE_USER"] ?? "agent_ro";
        private readonly string _password = config["CLICKHOUSE_PASSWORD"] ?? "";

        public async Task<string> QueryAsync(string sql, CancellationToken ct = default)
        {
            var url = $"{_baseUrl}/?user={Uri.EscapeDataString(_user)}" +
                  $"&password={Uri.EscapeDataString(_password)}" +
                  "&database=claudalytics" +
                  "&max_execution_time=30" +
                  "&max_result_rows=1000" +
                  "&result_overflow_mode=break";

            var response = await http.PostAsync(url, new StringContent(sql + " FORMAT TSVWithNames"), ct);
            var body = await response.Content.ReadAsStringAsync(ct);

            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"ClickHouse error: {body.Trim()}");

            return string.IsNullOrWhiteSpace(body) ? "(no rows)" : body.Trim();
        }
    }
}
