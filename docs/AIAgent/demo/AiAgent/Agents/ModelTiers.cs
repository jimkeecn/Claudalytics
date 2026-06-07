namespace AiAgent.Agents
{
    public class ModelTiers
    {
        public static string Light(IConfiguration config) => config["Models:Light"] ?? "claude-haiku-4-5";
        public static string Analyst(IConfiguration config) => config["Models:Analyst"] ?? "claude-sonnet-4-6";
        public static string Reasoning(IConfiguration config) => config["Models:Reasoning"] ?? "claude-opus-4-8";

    }
}
