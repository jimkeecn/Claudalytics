using AiAgent.Agents;
using AiAgent.Models;
using AiAgent.Orchestration;
using AiAgent.Tools;
using AiAgent.Workflows;
using Microsoft.Agents.AI;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Extensions.AI;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using System.Collections.Concurrent;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);

builder.Configuration.AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true);
builder.Services.AddSingleton<SchemaTools>();
builder.Services.AddSingleton(sp => AgentFactory.Create(
        sp.GetRequiredService<IConfiguration>(),
        sp.GetRequiredService<SchemaTools>(),
        sp.GetRequiredService<AnalysisTools>(),
        sp.GetRequiredKeyedService<AIAgent>("report"),
        sp.GetRequiredService<ILoggerFactory>()
    ));
builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource.AddService("claudalytics-agent"))
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddSource(AgentFactory.OtelSourceName)
        .AddSource("Experimental.Microsoft.Agents.AI")
        .AddSource("Experimental.Microsoft.Extensions.AI")
        .AddOtlpExporter());
builder.Services.AddKeyedSingleton("report", (sp, _) => ReportWorkflow.Create(
    sp.GetRequiredService<IConfiguration>(),
    sp.GetRequiredService<SchemaTools>(),
    sp.GetRequiredService<AnalysisTools>()));
builder.Services.AddSingleton(sp =>
{
    var reportAgent = sp.GetRequiredKeyedService<AIAgent>("report");

    return new MenuRegistry(
    [
        new MenuItem(
            Id: "telemetry-report",
            Title: "Telemetry report",
            Description: "Full multi-agent telemetry report: cost, security and tooling " +
                         "analysts run concurrently, a summarizer writes the report.",
            ParamsHint: "time window and optionally a project, e.g. 'last 7 days, project claudalytics'",
            TargetKind: "workflow",
            ModelTier: "Analyst+Reasoning",
            Invoke: async (parameters, ct) =>
            {
                var window = string.IsNullOrWhiteSpace(parameters) ? "the last 7 days" : parameters;
                var (report, _) = await ReportRunner.RunAsync(reportAgent, window, ct);
                return report;
            }),
    ]);
});

builder.Services.AddKeyedSingleton<AIAgent>("router", (sp, _) => Router.Create(
    sp.GetRequiredService<IConfiguration>(),
    sp.GetRequiredService<MenuRegistry>(),
    sp.GetRequiredService<ILoggerFactory>()));

builder.Services.AddSingleton<ConcurrentDictionary<string, AgentSession>>();
builder.Services.AddSingleton<ConcurrentDictionary<string, PendingApproval>>();
builder.Services.AddHttpClient<ClickHouseClient>();
builder.Services.AddSingleton<RecentUserMessages>();
builder.Services.AddSingleton<InvestigationService>();
builder.Services.AddSingleton<AnalysisTools>();


var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.MapGet("/healthz/llm", async (AIAgent agent, CancellationToken ct) =>
{
    var response = await agent.RunAsync("Reply with the single word: ok", cancellationToken: ct);
    return Results.Ok(new { status = "ok", model_reply = response.Text });
});

app.MapPost("/chat", async (
    ChatRequest request, AIAgent agent,
    [FromKeyedServices("router")] AIAgent router, MenuRegistry menu,
    ConcurrentDictionary<string, AgentSession> sessions,
    ConcurrentDictionary<string, PendingApproval> approvals,
    RecentUserMessages recent, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.Message))
        return Results.BadRequest(new { error = "message is required" });

    var (sessionId, session) =
        await GetOrCreateSessionAsync(request.SessionId, agent, sessions, ct);

    var routerPrompt = $"""
        Recent user messages in this session:
        {recent.Describe(sessionId)}

        New user message: {request.Message}
        """;
    var route = (await router.RunAsync<RouteDecision>(routerPrompt, cancellationToken: ct)).Result;

    recent.Add(sessionId, request.Message);

    switch (route.Intent.ToLowerInvariant())
    {
        case "menu":
            return Results.Ok(new
            {
                sessionId,
                kind = "menu",
                answer = (string?)null,
                menu = menu.Items.Select(item => new
                {
                    id = item.Id,
                    title = item.Title,
                    description = item.Description,
                    paramsHint = item.ParamsHint,
                }),
                toolCalls = Array.Empty<object>(),
                approvalRequest = (object?)null,
            });
        case "dispatch" when route.TargetId is not null && menu.TryGet(route.TargetId, out var item):
            var dispatched = await item.Invoke(route.Parameters, ct);
            return Results.Ok(new
            {
                sessionId,
                kind = "answer",
                answer = dispatched,
                menu = (object?)null,
                toolCalls = new[] { new { name = item.Id, arguments = (object?)route.Parameters } },
                approvalRequest = (object?)null,
            });
        default:
            var response = await agent.RunAsync(request.Message, session, cancellationToken: ct);
            return Results.Ok(ToChatResponse(sessionId, session, response, approvals));
    }
});

app.MapPost("/chat/stream", async (HttpContext context, AIAgent agent,
    ConcurrentDictionary<string, AgentSession> sessions, CancellationToken ct) =>
{
    var request = await context.Request.ReadFromJsonAsync<ChatRequest>(ct);
    if (request is null || string.IsNullOrWhiteSpace(request.Message))
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }
    var (sessionId, session) =
        await GetOrCreateSessionAsync(request.SessionId, agent, sessions, ct);

    context.Response.Headers.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";

    await SseEvent.WriteAsync(context.Response, "session", new { sessionId }, ct);

    try
    {
        await foreach (var update in
            agent.RunStreamingAsync(request.Message, session, cancellationToken: ct))
        {
            foreach (var content in update.Contents)
            {
                if (content is FunctionCallContent call)
                {
                    await SseEvent.WriteAsync(context.Response, "tool_call",
                        new { name = call.Name, arguments = call.Arguments }, ct);
                }
            }

            if (!string.IsNullOrEmpty(update.Text))
                await SseEvent.WriteAsync(context.Response, "token",
                    new { text = update.Text }, ct);
        }

        await SseEvent.WriteAsync(context.Response, "done", new { }, ct);
    }
    catch (Exception ex)
    {
        await SseEvent.WriteAsync(context.Response, "error",
            new { message = ex.Message }, ct);
    }
});

app.MapPost("/probe", async (InvestigationRequest request, ClickHouseClient clickHouse, CancellationToken ct) =>
{
    var workflow = ProbeWorkflow.Build(clickHouse);
    var run = await InProcessExecution.RunAsync(workflow, request, cancellationToken:ct);
    string? report = null;

    foreach (var evt in run.NewEvents)
    {
        if (evt is WorkflowOutputEvent output)
            report = output.Data?.ToString();
    }

    return Results.Ok(new { report });
});

app.MapPost("/investigate", async (int days, InvestigationService svc, CancellationToken ct) =>
    Results.Ok(await svc.StartAsync(days, ct)));

app.MapPost("/workflow/investigate", async (InvestigateRequest? request, InvestigationService service, CancellationToken ct) =>
    Results.Ok(await service.StartAsync(request?.Days ?? 7, ct)));

app.MapPost("/workflow/{runId}/respond", async (string runId, WorkflowRespondRequest request,
    InvestigationService service, CancellationToken ct) =>
{
    var status = await service.RespondAsync(runId, request.Approve, ct);
    return status is null
        ? Results.NotFound(new { error = "no run awaiting approval with that id (after a restart, use /resume)" })
        : Results.Ok(status);
});

app.MapPost("/workflow/{runId}/resume", async (string runId, InvestigationService service, CancellationToken ct) =>
{
    var status = await service.ResumeAsync(runId, ct);
    return status is null
        ? Results.NotFound(new { error = "no checkpoints found for that run id" })
        : Results.Ok(status);
});

app.MapPost("/analyze/cost", async (AnalyzeCostRequest? request, AIAgent agent, CancellationToken ct) =>
{
    var window = string.IsNullOrWhiteSpace(request?.Window) ? "the last 7 days" : request.Window;
    var groupBy = string.IsNullOrWhiteSpace(request?.GroupBy) ? "project" : request.GroupBy;
    var projectScope = string.IsNullOrWhiteSpace(request?.Project)
        ? ""
        : $", restricted to project {request.Project}";

    var session = await agent.CreateSessionAsync(ct);
    await agent.RunAsync(
        $"Gather the cost data for {window}, grouped by {groupBy}{projectScope}, using the CostBreakdown tool. " +
        "Reply with just the raw data.", session, cancellationToken: ct);

    var response = await agent.RunAsync<CostBreakdownReport>(
        "Now produce the final report from the data you just gathered. Do not call any tools.",
        session, cancellationToken: ct);

    return Results.Ok(response.Result);
});

app.MapPost("/chat/approve", async (ApproveRequest request, AIAgent agent,
    ConcurrentDictionary<string, PendingApproval> approvals, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.ApprovalId)
        || !approvals.TryRemove(request.ApprovalId, out var pending))
        return Results.NotFound(new { error = "unknown or already-handled approvalId" });

    var reply = new ChatMessage(ChatRole.User,
        [pending.Request.CreateResponse(request.Approved, request.Reason ?? "")]);

    var response = await agent.RunAsync(reply, pending.Session, cancellationToken: ct);
    return Results.Ok(ToChatResponse(pending.SessionId, pending.Session, response, approvals));
});

app.MapPost("/report", async (ReportRequest? request,
    [FromKeyedServices("report")] AIAgent reportAgent, CancellationToken ct) =>
{
    var window = string.IsNullOrWhiteSpace(request?.Window) ? "the last 7 days" : request.Window;
    var (report, agentsInvolved) = await ReportRunner.RunAsync(reportAgent, window, ct);
    return Results.Ok(new { report, agentsInvolved });
});

app.MapPost("/report/stream", async (ReportRequest ? request, HttpContext context,
    [FromKeyedServices("report")] AIAgent reportAgent, CancellationToken ct) =>
{
    var window = string.IsNullOrWhiteSpace(request?.Window) ? "the last 7 days" : request!.Window;

    context.Response.Headers.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-cache";

    try
    {
        string? currentAgent = null;
        await foreach (var update in reportAgent.RunStreamingAsync(
            $"Produce the report for {window}.", cancellationToken: ct))
        {
            if (!string.IsNullOrEmpty(update.AuthorName) && update.AuthorName != currentAgent)
            {
                currentAgent = update.AuthorName;
                await SseEvent.WriteAsync(context.Response, "agent_step", new { agent = currentAgent }, ct);
            }
            if (!string.IsNullOrEmpty(update.Text))
                await SseEvent.WriteAsync(context.Response, "token",
                    new { agent = currentAgent, text = update.Text }, ct);
        }
        await SseEvent.WriteAsync(context.Response, "done", new { }, ct);
    }
    catch (Exception ex)
    {
        await SseEvent.WriteAsync(context.Response, "error", new { message = ex.Message }, ct);
    }
});

app.MapGet("/menu", (MenuRegistry menu) => Results.Ok(new
{
    items = menu.Items.Select(item => new
    {
        id = item.Id,
        title = item.Title,
        description = item.Description,
        paramsHint = item.ParamsHint,
        targetKind = item.TargetKind,
        modelTier = item.ModelTier,
    }),
}));

app.MapPost("/menu/invoke", async (MenuInvokeRequest request, MenuRegistry menu, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.ItemId) || !menu.TryGet(request.ItemId, out var item))
        return Results.NotFound(new { error = $"unknown menu item '{request.ItemId}'" });

    var answer = await item.Invoke(request.Params, ct);
    return Results.Ok(new
    {
        sessionId = request.SessionId,
        kind = "answer",
        answer,
        menu = (object?)null,
        toolCalls = new[] { new { name = item.Id, arguments = (object?)request.Params } },
        approvalRequest = (object?)null,
    });
});

app.Run();



static object ToChatResponse(string sessionId, AgentSession session, AgentResponse response,
        ConcurrentDictionary<string, PendingApproval> approvals)
{
    var contents = response.Messages.SelectMany(message => message.Contents).ToList();

    var toolCalls = contents.OfType<FunctionCallContent>()
        .Select(call => new { name = call.Name, arguments = (object?)call.Arguments })
        .ToList();

    var approvalRequest = contents.OfType<ToolApprovalRequestContent>()
        .Select(approval =>
        {
            var call = approval.ToolCall as FunctionCallContent;
            return new
            {
                approvalId = StoreApproval(approvals, sessionId, session, approval),
                toolName = call?.Name,
                arguments = call?.Arguments,
            };
        })
        .FirstOrDefault();

    return new
    {
        sessionId,
        kind = approvalRequest is null ? "answer" : "approval",
        answer = response.Text,
        menu = (object?)null,
        toolCalls,
        approvalRequest,
    };
}

static string StoreApproval(
    ConcurrentDictionary<string, PendingApproval> approvals,
    string sessionId, AgentSession session, ToolApprovalRequestContent request)
{
    var approvalId = Guid.NewGuid().ToString("N");
    approvals[approvalId] = new PendingApproval(sessionId, session, request);
    return approvalId;
}

static async Task<(string SessionId, AgentSession Session)> GetOrCreateSessionAsync(
    string? requestedSessionId, AIAgent agent,
    ConcurrentDictionary<string, AgentSession> sessions, CancellationToken ct)
{
    var sessionId = string.IsNullOrWhiteSpace(requestedSessionId)
        ? Guid.NewGuid().ToString("N")
        : requestedSessionId;

    if (!sessions.TryGetValue(sessionId, out var session))
    {
        session = await agent.CreateSessionAsync(ct);
        sessions[sessionId] = session;
    }

    return (sessionId, session);
}

internal sealed class RecentUserMessages
{
    private const int Keep = 3;
    private readonly ConcurrentDictionary<string, Queue<string>> _store = new();

    public void Add(string sessionId, string message)
    {
        var queue = _store.GetOrAdd(sessionId, _ => new Queue<string>());
        lock (queue)
        {
            queue.Enqueue(message);
            while (queue.Count > Keep) queue.Dequeue();
        }
    }

    public string Describe(string sessionId)
    {
        if (!_store.TryGetValue(sessionId, out var queue)) return "(none)";
        lock (queue)
        {
            return queue.Count == 0 ? "(none)" : string.Join("\n", queue.Select(m => $"- {m}"));
        }
    }
}

internal sealed record ChatRequest(string Message, string? SessionId);

internal static class SseEvent
{
    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web);

    public static async Task WriteAsync(
        HttpResponse response, string eventName, object data, CancellationToken ct
        )
    {
        await response.WriteAsync(
          $"event: {eventName}\ndata: {JsonSerializer.Serialize(data, JsonOptions)}\n\n", ct);
        await response.Body.FlushAsync();
    }

    
}

internal sealed record InvestigateRequest(int Days);
internal sealed record WorkflowRespondRequest(bool Approve);
internal sealed record AnalyzeCostRequest(string? Window, string? GroupBy, string? Project);
internal sealed record PendingApproval(
    string SessionId,
    AgentSession Session,
    ToolApprovalRequestContent Request);
internal sealed record ApproveRequest(string ApprovalId, bool Approved, string? Reason);
internal sealed record ReportRequest(string? Window);
internal sealed record MenuInvokeRequest(string ItemId, string? Params, string? SessionId);