using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;

namespace AiAgent.Middleware;

public sealed class ToolCallLoggingChatClient(IChatClient innerClient, ILogger logger)
    : DelegatingChatClient(innerClient)
{
    public override async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var response = await base.GetResponseAsync(messages, options, cancellationToken);

        foreach (var call in response.Messages
            .SelectMany(m => m.Contents)
            .OfType<FunctionCallContent>())
            logger.LogInformation("Tool call requested: {Tool} {Args}",
                call.Name, System.Text.Json.JsonSerializer.Serialize(call.Arguments));

        if (response.Usage is { } usage)
            logger.LogInformation("Model round-trip: in={Input} out={Output} tokens",
                usage.InputTokenCount, usage.OutputTokenCount);

        return response;
    }

    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages, ChatOptions? options = null,
        [System.Runtime.CompilerServices.EnumeratorCancellation]
        CancellationToken cancellationToken = default)
    {
        await foreach (var update in base.GetStreamingResponseAsync(
            messages, options, cancellationToken))
        {
            foreach (var call in update.Contents.OfType<FunctionCallContent>())
                logger.LogInformation("Tool call requested (stream): {Tool}", call.Name);
            yield return update;
        }
    }
}