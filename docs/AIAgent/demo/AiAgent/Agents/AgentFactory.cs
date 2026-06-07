using AiAgent.Middleware;
using AiAgent.Tools;
using Anthropic;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Compaction;
using Microsoft.Extensions.AI;

namespace AiAgent.Agents
{
    public class AgentFactory
    {
        public const string OtelSourceName = "Claudalytics.Agent";
        public static AIAgent Create(
            IConfiguration config,
            SchemaTools tools, 
            AnalysisTools analysis,
            AIAgent reportAgent,
            ILoggerFactory loggerFactory)
        {
            var apiKey = config["ANTHROPIC_API_KEY"] ?? throw new InvalidOperationException("ANTHROPIC_API_KEY is not set");

            IAnthropicClient client = new AnthropicClient { ApiKey = apiKey };

            var options = new ChatClientAgentOptions
            {
                Name = "claudalytics-analyst",
                Description = "Answers natural-language questions over Claudalytics telemetry in ClickHouse.",
                ChatOptions = new ChatOptions
                {
                    ModelId = ModelTiers.Analyst(config),
                    Instructions = Instructions.System,
                    Tools = [
                            AIFunctionFactory.Create(tools.GetSchema),
                            AIFunctionFactory.Create(tools.RunSql),
                            new ApprovalRequiredAIFunction(AIFunctionFactory.Create(tools.RunUnboundedSql)),
                            AIFunctionFactory.Create(tools.ListProjects),
                            AIFunctionFactory.Create(tools.ListRecentSessions),
                            AIFunctionFactory.Create(analysis.CostBreakdown),
                            AIFunctionFactory.Create(analysis.SessionDeepDive),
                            reportAgent.AsAIFunction(new AIFunctionFactoryOptions
                            {
                                Name = "run_telemetry_report",
                                Description = "Runs the full multi-agent telemetry report " +
                                              "(cost + security + tooling analysts, then a summarizer). " +
                                              "Expensive — only when the user asks for the telemetry report. " +
                                              "Input: the time window, e.g. 'the last 7 days'.",
                            }),
                        ]
                }
            };

            var agent = client.AsAIAgent(
            options,
            clientFactory: inner => 
            new ToolCallLoggingChatClient(inner, loggerFactory.CreateLogger<ToolCallLoggingChatClient>()),
            loggerFactory: loggerFactory);

            return agent.AsBuilder()
            .UseOpenTelemetry(OtelSourceName)
            .Build();
        }
    }
}
