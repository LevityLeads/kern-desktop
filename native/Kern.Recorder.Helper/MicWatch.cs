using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kern.Recorder.Helper;

// --mic-watch mode: poll which processes hold an active capture session and print one JSON line
// per change plus a heartbeat every 30 s of silence. The desktop decides what a call is; this
// only reports who has the microphone. The helper's own PID and its parent's are never reported.
internal sealed class MicWatch(
    IMicSessionSource source,
    IReadOnlyCollection<int> excludedPids,
    Action<string> emit,
    Func<long> nowMs)
{
    public const int HeartbeatMs = 30_000;
    public const int PollMs = 1_000;

    private static readonly JsonSerializerOptions JsonOptions = new() { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    private string? lastSignature;
    private long lastEmitMs;
    private bool failing;

    // One pass. Emits at most one line.
    public void Poll()
    {
        IReadOnlyList<MicHolder> apps;
        try { apps = Collect(); }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // Only report the first failure of a streak, not one line a second.
            if (!failing) { failing = true; Write(new ErrorLine("error", "enumerate-failed")); }
            return;
        }
        failing = false;
        var signature = string.Join(",", apps.Select(app => $"{app.Pid}:{app.Name}:{app.Endpoint}"));
        var now = nowMs();
        if (signature == lastSignature && now - lastEmitMs < HeartbeatMs) return;
        lastSignature = signature;
        lastEmitMs = now;
        Write(new MicLine("mic", apps.Select(app => new MicApp(app.Pid, app.Name, app.Endpoint)).ToList()));
    }

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            Poll();
            try { await Task.Delay(PollMs, cancellationToken).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    // One entry per process per endpoint: a process holding two microphones is listed twice.
    private List<MicHolder> Collect()
    {
        var found = new Dictionary<(int Pid, string Endpoint), MicHolder>();
        var endpoints = source.Endpoints();
        try
        {
            foreach (var endpoint in endpoints)
            {
                try
                {
                    var id = endpoint.Id;
                    foreach (var session in endpoint.ActiveSessions())
                        if (!excludedPids.Contains(session.Pid)) found[(session.Pid, id)] = new MicHolder(session.Pid, session.Name, id);
                }
                // A device that vanishes or refuses to enumerate must not hide the others.
                catch (Exception error) when (error is not OutOfMemoryException) { }
            }
        }
        finally
        {
            foreach (var endpoint in endpoints) endpoint.Dispose();
        }
        return found.Values.OrderBy(app => app.Pid).ThenBy(app => app.Endpoint, StringComparer.Ordinal).ToList();
    }

    private void Write(object line) => emit(JsonSerializer.Serialize(line, line.GetType(), JsonOptions));

    private readonly record struct MicHolder(int Pid, string Name, string Endpoint);
    private sealed record MicApp(
        [property: JsonPropertyName("pid")] int Pid,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("endpoint")] string Endpoint);
    private sealed record MicLine([property: JsonPropertyName("type")] string Type, [property: JsonPropertyName("apps")] List<MicApp> Apps);
    private sealed record ErrorLine([property: JsonPropertyName("type")] string Type, [property: JsonPropertyName("code")] string Code);
}
