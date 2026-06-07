using System.ComponentModel;

namespace AiAgent.Models;

public sealed record RouteDecision(
    [property: Description("One of: 'chat' (free-form data question or follow-up — send to the analyst), " +
        "'menu' (user asks what the copilot can do, or wants to see the available actions), " +
        "'dispatch' (the message clearly requests one specific catalog item).")]
    string Intent,

    [property: Description("When intent is 'dispatch': the id of the catalog item to run. Otherwise null.")]
    string? TargetId,

    [property: Description("When intent is 'dispatch': parameters extracted from the message, " +
        "e.g. the time window like 'the last 7 days'. Otherwise null.")]
    string? Parameters);