using System.IO.Pipes;
using System.Text.Json;

namespace Kern.Recorder.Helper;

internal sealed class HelperServer : IDisposable
{
    private readonly HelperOptions options;
    private readonly AudioDevices devices;
    private readonly RecorderEngine engine;
    private readonly CancellationTokenSource shutdown = new();
    private readonly SemaphoreSlim writeGate = new(1, 1);
    private NamedPipeServerStream? pipe;
    private bool disposed;

    public HelperServer(HelperOptions options)
    {
        this.options = options;
        devices = new AudioDevices();
        engine = new RecorderEngine(devices, new TimelineClock()) { AppBuild = options.AppBuild };
        engine.StatusChanged += OnStatusChanged;
        devices.StartNotifications(shutdown.Token);
    }

    public async Task RunAsync()
    {
        using var watchdog = new ParentWatchdog(options.ParentProcessId, OnParentDeath);
        pipe = new NamedPipeServerStream(
            options.PipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance,
            64 * 1024,
            64 * 1024);
        await pipe.WaitForConnectionAsync(shutdown.Token).ConfigureAwait(false);
        if (!WindowsNative.IsNamedPipeClientProcess(pipe, options.ParentProcessId))
            throw new UnauthorizedAccessException("Capture helper rejected a non-parent pipe client.");

        while (!shutdown.IsCancellationRequested && pipe.IsConnected)
        {
            using var message = await Protocol.ReadAsync(pipe, shutdown.Token).ConfigureAwait(false);
            if (message is null) break;
            await HandleAsync(message.RootElement, shutdown.Token).ConfigureAwait(false);
        }
    }

    private async Task HandleAsync(JsonElement root, CancellationToken cancellationToken)
    {
        long requestId = 0;
        try
        {
            if (!root.TryGetProperty("type", out var type) || type.GetString() != "request")
                throw new ProtocolException("invalid-request", "Only request messages are accepted.");
            requestId = Protocol.RequireRequestId(root);
            if (!root.TryGetProperty("protocolVersion", out var version) || version.GetInt32() != Protocol.Version)
                throw new ProtocolException("incompatible-protocol", "Capture protocol is incompatible.");
            var command = Protocol.RequireCommand(root);
            var payload = Protocol.RequirePayload(root);
            var result = Execute(command, payload);
            await WriteAsync(new { type = "response", protocolVersion = Protocol.Version, requestId, ok = true, result }, cancellationToken).ConfigureAwait(false);
            if (command == "shutdown") shutdown.Cancel();
        }
        catch (Exception error) when (error is ProtocolException or JsonException or InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            var code = error is ProtocolException protocolError ? protocolError.Code : "helper-error";
            await WriteAsync(new
            {
                type = "response",
                protocolVersion = Protocol.Version,
                requestId,
                ok = false,
                error = new { code, message = error.Message },
            }, cancellationToken).ConfigureAwait(false);
        }
    }

    private object Execute(string command, JsonElement payload) => command switch
    {
        "hello" => Hello(payload),
        "ping" => EmptyPayload(payload, new { protocolVersion = Protocol.Version }),
        "list-devices" => EmptyPayload(payload, engine.ListDevices()),
        "start" => engine.Start(Deserialize<StartRequest>(payload)),
        "pause" => engine.Pause(DeserializeControl(payload)),
        "resume" => engine.Resume(DeserializeControl(payload)),
        "mute-mic" => engine.SetMicMuted(true, DeserializeControl(payload)),
        "unmute-mic" => engine.SetMicMuted(false, DeserializeControl(payload)),
        "stop" => engine.Stop(DeserializeControl(payload)),
        "suspend" => engine.Suspend(DeserializeControl(payload)),
        "recover" => engine.Recover(Deserialize<RecoverRequest>(payload)),
        "shutdown" => EmptyPayload(payload, new { state = "shutdown" }),
        _ => throw new ProtocolException("unknown-command", "Unknown capture helper command."),
    };

    private static object Hello(JsonElement payload)
    {
        RequireOnlyProperties(payload, "protocolVersion");
        if (!payload.TryGetProperty("protocolVersion", out var version) || version.GetInt32() != Protocol.Version)
            throw new ProtocolException("incompatible-protocol", "Capture protocol is incompatible.");
        return new { protocolVersion = Protocol.Version, helperVersion = RecorderEngine.HelperVersion };
    }

    private static T Deserialize<T>(JsonElement payload) where T : class =>
        payload.Deserialize<T>(Protocol.JsonOptions) ?? throw new ProtocolException("invalid-payload", "Command payload is invalid.");

    private static T EmptyPayload<T>(JsonElement payload, T result)
    {
        RequireOnlyProperties(payload);
        return result;
    }

    private static void RequireOnlyProperties(JsonElement payload, params ReadOnlySpan<string> properties)
    {
        foreach (var property in payload.EnumerateObject())
        {
            if (!properties.ToArray().Contains(property.Name, StringComparer.Ordinal))
                throw new ProtocolException("invalid-payload", $"Unknown payload property: {property.Name}");
        }
    }

    private static ControlRequest DeserializeControl(JsonElement payload)
    {
        var request = Deserialize<ControlRequest>(payload);
        if (request.RequestedAtUnixMs <= 0 || !double.IsFinite(request.RequestedAtMonotonicMs) || request.RequestedAtMonotonicMs <= 0)
            throw new ProtocolException("invalid-payload", "Control request time is invalid.");
        return request;
    }

    private void OnStatusChanged(object? sender, RecorderStatus status)
    {
        if (!shutdown.IsCancellationRequested) _ = SendEventAsync("status", status);
    }

    private async Task SendEventAsync(string eventName, object payload)
    {
        try
        {
            await WriteAsync(new { type = "event", protocolVersion = Protocol.Version, @event = eventName, payload }, shutdown.Token).ConfigureAwait(false);
        }
        catch { shutdown.Cancel(); }
    }

    private async Task WriteAsync(object message, CancellationToken cancellationToken)
    {
        var connectedPipe = pipe;
        if (connectedPipe is null || !connectedPipe.IsConnected) return;
        await writeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try { await Protocol.WriteAsync(connectedPipe, message, cancellationToken).ConfigureAwait(false); }
        finally { writeGate.Release(); }
    }

    private const int ParentDeathStopDeadlineMs = 750;

    private static ControlRequest FailureControl() => new(
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        System.Diagnostics.Stopwatch.GetTimestamp() * 1000d / System.Diagnostics.Stopwatch.Frequency,
        Reason: "failure");

    private void OnParentDeath()
    {
        // The desktop parent is gone, so this process must terminate promptly and
        // unconditionally. A best-effort stop runs on a background thread with a hard
        // deadline: engine.Stop can block on a stalled disk flush, and FailFast must
        // never wait on it. Once the deadline passes we terminate regardless, so the
        // orphaned capture cannot outlive the parent past the parent-death budget.
        try
        {
            var stopAttempt = Task.Run(() =>
            {
                try { engine.Stop(FailureControl()); }
                catch { }
            });
            stopAttempt.Wait(ParentDeathStopDeadlineMs);
        }
        catch { }
        Environment.FailFast("Desktop parent exited while capture helper was active.");
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        shutdown.Cancel();
        try { engine.Stop(FailureControl()); }
        catch { }
        engine.StatusChanged -= OnStatusChanged;
        engine.Dispose();
        devices.Dispose();
        pipe?.Dispose();
        writeGate.Dispose();
        shutdown.Dispose();
    }
}
