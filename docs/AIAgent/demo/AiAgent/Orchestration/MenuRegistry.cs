namespace AiAgent.Orchestration;

public sealed record MenuItem(
    string Id,
    string Title,
    string Description,
    string ParamsHint,
    string TargetKind,
    string ModelTier,
    Func<string?, CancellationToken, Task<string>> Invoke);

public sealed class MenuRegistry(IEnumerable<MenuItem> items)
{
    private readonly Dictionary<string, MenuItem> _items =
        items.ToDictionary(item => item.Id, StringComparer.OrdinalIgnoreCase);

    public IReadOnlyCollection<MenuItem> Items => _items.Values;

    public bool TryGet(string id, out MenuItem item) => _items.TryGetValue(id, out item!);

    public string CatalogForPrompt() => string.Join("\n", _items.Values.Select(item =>
        $"- {item.Id}: {item.Description} (params: {item.ParamsHint})"));
}