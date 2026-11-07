using System.Collections.Concurrent;

internal sealed class HostTaskScope : IDisposable
{
    private static readonly ConcurrentDictionary<string, HostTaskScope> Active = new(StringComparer.Ordinal);
    private readonly string taskId;
    private readonly CancellationTokenSource cancellation;
    private readonly object gate = new();
    private bool disposed;
    private int cancelCalls, explicitlyCancelled;

    internal CancellationToken Token { get; }
    internal bool Cancelled => Volatile.Read(ref explicitlyCancelled) != 0;
    internal int Timeout { get; }

    private HostTaskScope(string taskId, int timeout, CancellationToken parent)
    {
        this.taskId = taskId;
        Timeout = timeout;
        cancellation = CancellationTokenSource.CreateLinkedTokenSource(parent);
        Token = cancellation.Token;
        cancellation.CancelAfter(timeout);
    }

    internal static HostTaskScope Open(string taskId, int timeout, CancellationToken parent = default)
    {
        taskId ??= Guid.NewGuid().ToString("N");
        ValidateTaskId(taskId);
        if (timeout is < 1 or > 120000)
            throw RuleProcess.Error("RULE_REQUEST", "timeout must be 1..120000ms");
        var scope = new HostTaskScope(taskId, timeout, parent);
        if (!Active.TryAdd(taskId, scope))
        {
            scope.cancellation.Dispose();
            throw RuleProcess.Error("RULE_REQUEST", "duplicate active taskId");
        }
        return scope;
    }

    internal static void ValidateTaskId(string taskId)
    {
        if (string.IsNullOrEmpty(taskId) || taskId.Length > 80 ||
            taskId.Any(c => c is not (>= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-')))
            throw RuleProcess.Error("RULE_REQUEST", "taskId must be 1..80 characters from A-Z, a-z, 0-9, _ or -");
    }

    internal static bool Cancel(string taskId)
    {
        ValidateTaskId(taskId);
        return Active.TryGetValue(taskId, out var scope) && scope.CancelActive();
    }

    private bool CancelActive()
    {
        lock (gate)
        {
            if (disposed) return false;
            Volatile.Write(ref explicitlyCancelled, 1);
            cancelCalls++;
        }
        // Callbacks run outside the lock and may dispose this scope or open a replacement.
        // Keep the CTS alive until every concurrent Cancel call has returned.
        try { cancellation.Cancel(); return true; }
        finally
        {
            bool release;
            lock (gate) release = --cancelCalls == 0 && disposed;
            if (release) cancellation.Dispose();
        }
    }

    public void Dispose()
    {
        bool release;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            Active.TryRemove(taskId, out _);
            release = cancelCalls == 0;
        }
        if (release) cancellation.Dispose();
    }
}
