using System.ComponentModel;

namespace AiAgent.Models;

public sealed record CostBreakdownReport(
    [property: Description("Two or three sentence interpretation of the spend, written for a human.")]
    string Summary,
    [property: Description("Total cost in USD over the analyzed window.")]
    double TotalCostUsd,
    [property: Description("Cost lines, highest cost first.")]
    List<CostLine> Lines,
    [property: Description("Anything unusual worth flagging; empty when nothing stands out.")]
    List<string> Anomalies);

public sealed record CostLine(
    [property: Description("The group value, e.g. a model name, project or day.")]
    string Group,
    double CostUsd,
    long InputTokens,
    long OutputTokens);