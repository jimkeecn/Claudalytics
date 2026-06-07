using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Checkpointing;
using System.Collections.Concurrent;

namespace AiAgent.Workflows;

public sealed record WorkflowEventDto(string Type, string? Detail);
public sealed record InvestigationStatus(
    string RunId,
    string Status,          
    string? Report,
    List<WorkflowEventDto> Events);
public sealed class InvestigationService
{
    private readonly Func<Workflow> _workflowFactory;
    private readonly CheckpointManager _checkpointManager;
    private readonly FileSystemJsonCheckpointStore _store;
    private readonly DirectoryInfo _checkpointDir;
    private readonly ILogger<InvestigationService> _logger;
    private readonly ConcurrentDictionary<string, (StreamingRun Run, ExternalRequest Request)> _pending = new();

    public InvestigationService(IConfiguration config, Tools.ClickHouseClient clickHouse, ILogger<InvestigationService> logger)
    {
        _logger = logger;
        var dir = new DirectoryInfo(config["CHECKPOINT_DIR"] ?? "checkpoints");
        dir.Create();
        _checkpointDir = dir;
        _store = new FileSystemJsonCheckpointStore(dir);
        _checkpointManager = CheckpointManager.CreateJson(_store, null);
        _workflowFactory = () => InvestigationWorkflow.Build(config, clickHouse);
    }
    private static WorkflowEventDto? ToDto(WorkflowEvent evt) => evt switch
    {
        WorkflowStartedEvent => new("workflow_started", null),
        SuperStepCompletedEvent => new("superstep_completed", null),
        ExecutorInvokedEvent invoked => new("executor_invoked", invoked.ExecutorId),
        ExecutorCompletedEvent completed => new("executor_completed", completed.ExecutorId),
        ExecutorFailedEvent failed => new("executor_failed",
            $"{failed.ExecutorId}: {(failed.Data as Exception)?.GetBaseException().Message ?? failed.Data?.ToString()}"),
        InvestigationProgressEvent progress => new("progress", progress.Message),
        WorkflowOutputEvent => new("workflow_output", "report ready"),
        _ => null,
    };

    private async Task<InvestigationStatus> DriveAsync(string runId, 
        StreamingRun run, List<WorkflowEventDto> events, CancellationToken ct)
    {
        string? report = null;
        try
        {
            await foreach (var evt in run.WatchStreamAsync(ct))
            {
                var dto = ToDto(evt);
                if (dto is not null) events.Add(dto);

                if (evt is WorkflowOutputEvent output)
                    report = output.Data?.ToString();
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Investigation run {RunId} failed.", runId);
            events.Add(new("error", ex.Message));
            return new InvestigationStatus(runId, "failed", null, events);
        }

        return new InvestigationStatus(runId, report is null ? "failed" : "completed", report, events);
    }

    public async Task<InvestigationStatus> StartAsync(int days, CancellationToken ct)
    {
        var runId = Guid.NewGuid().ToString("N");
        var run = await InProcessExecution.RunStreamingAsync(
            _workflowFactory(), new InvestigationRequest(days), _checkpointManager, runId, ct);
        return await DriveAsync(runId, run, [], ct);
    }

    public async Task<InvestigationStatus?> RespondAsync(string runId, bool approve, CancellationToken ct)
    {
        if (!_pending.TryRemove(runId, out var pending))
            return null;

        await pending.Run.SendResponseAsync(pending.Request.CreateResponse(new DeepDiveDecision(approve)));
        return await DriveAsync(runId, pending.Run, [], ct);
    }

    public async Task<InvestigationStatus?> ResumeAsync(string runId, CancellationToken ct)
    {
        var mine = (await _store.RetrieveIndexAsync(runId, null))
            .Where(checkpoint => checkpoint.SessionId == runId)
            .Select(checkpoint => (Info: checkpoint, WrittenAt: CheckpointWrittenAt(runId, checkpoint)))
            .OrderBy(entry => entry.WrittenAt)
            .ToList();

        if (mine.Count == 0)
            return null;

        _pending.TryRemove(runId, out _);
        var run = await InProcessExecution.ResumeStreamingAsync(_workflowFactory(), mine[^1].Info, _checkpointManager, ct);
        return await DriveAsync(runId, run, [new("resumed", $"from checkpoint {mine.Count} of run {runId}")], ct);
    }

    private DateTime CheckpointWrittenAt(string runId, CheckpointInfo checkpoint)
    {
        var file = _checkpointDir.GetFiles($"{runId}_{checkpoint.CheckpointId}*").FirstOrDefault();
        return file?.LastWriteTimeUtc ?? DateTime.MinValue;
    }
}



