namespace Kern.Recorder.Helper;

// Test seams for the parts of a session that touch the machine. Production uses the defaults.
internal sealed record RecorderEngineOptions
{
    public Func<string, long> FreeSpace { get; init; } = DriveFreeSpace;
    public Func<string, ICallSink> OpenSink { get; init; } = path => new CallWriter(path);
    // Off in tests, which drive Tick() by hand against a fake clock.
    public bool RunLoop { get; init; } = true;

    private static long DriveFreeSpace(string path) =>
        new DriveInfo(System.IO.Path.GetPathRoot(path) ?? throw new IOException("Recording path has no drive.")).AvailableFreeSpace;
}

// The helper's session state machine: idle -> recording <-> paused -> stopped | interrupted.
// Commands arrive on the pipe thread, the timer drives Tick(), device notifications only raise
// a flag. Capture threads never enter this lock.
internal sealed partial class RecorderEngine : IDisposable
{
    private const long MinimumStartFreeBytes = 256L * 1024 * 1024;
    private static readonly RecorderStatus IdleStatus = new("idle", null, null, 0, 0, false, null, [], null, null);

    private readonly object gate = new();
    private readonly ICaptureBackend backend;
    private readonly TimelineClock clock;
    private readonly int excludedProcessId;
    private readonly RecorderEngineOptions options;
    private CallSession? session;
    private CancellationTokenSource? loopCancellation;
    private int devicesChanged;
    private bool disposed;

    public RecorderEngine(ICaptureBackend backend, TimelineClock clock, int excludedProcessId, RecorderEngineOptions? options = null)
    {
        this.backend = backend;
        this.clock = clock;
        this.excludedProcessId = excludedProcessId;
        this.options = options ?? new RecorderEngineOptions();
        backend.DevicesChanged += OnDevicesChanged;
    }

    public event EventHandler<RecorderStatus>? StatusChanged;

    public static string HelperVersion { get; } =
        typeof(RecorderEngine).Assembly.GetName().Version?.ToString() ?? "unknown";

    // Desktop build label passed on the command line; "unknown" when launched by hand.
    public string? AppBuild { get; init; }

    private ProducerInfo Producer => new(AppBuild ?? "unknown", HelperVersion, Protocol.Version);

    public DeviceList ListDevices() => backend.ListDevices();

    public RecorderStatus Start(StartRequest request)
    {
        RecorderStatus status;
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (session is { IsActive: true }) throw new ProtocolException("already-recording", "A capture session is already active.");
            var path = ValidateStart(request);
            if (options.FreeSpace(path) < MinimumStartFreeBytes)
                throw new IOException("At least 256 MB of free disk space is required to start recording.");
            WindowsNative.RestrictDirectoryToCurrentUser(path);
            var sink = options.OpenSink(path);
            CallSession created;
            try { created = new CallSession(request.SessionId, path, request.Microphone, new SessionClock(clock, clock.NowTicks), sink); }
            catch { sink.Dispose(); throw; }
            try
            {
                OpenSources(created);
                created.Commit.WriteSession(created.Document(Producer, clock.NowTicks));
            }
            catch
            {
                created.Dispose();
                throw;
            }
            session = created;
            var now = clock.NowTicks;
            created.NextStatusTicks = now + StatusInterval;
            created.NextSessionWriteTicks = now + SessionWriteInterval;
            created.NextHousekeepingTicks = now + HousekeepingInterval;
            StartLoop();
            status = created.Status(now);
        }
        StatusChanged?.Invoke(this, status);
        return status;
    }

    public RecorderStatus Pause(ControlRequest request) => Control(request, (active, frame) =>
    {
        if (active.IsPaused) return false;
        active.Pause("user", frame);
        return true;
    });

    // A system suspend while already paused keeps the user's pause, so resuming after wake
    // does not need to know which one came first.
    public RecorderStatus Suspend(ControlRequest request) => Control(request, (active, frame) =>
    {
        if (active.IsPaused) return false;
        active.Pause("suspend", frame);
        return true;
    });

    public RecorderStatus Resume(ControlRequest request) => Control(request, (active, frame) =>
    {
        if (!active.IsPaused) throw new ProtocolException("invalid-state", "Recording is not paused.");
        active.Resume(frame);
        return true;
    });

    public RecorderStatus SetMicMuted(bool muted, ControlRequest request)
    {
        if (request.Muted is not null && request.Muted != muted)
            throw new ProtocolException("invalid-payload", "Microphone mute payload does not match the command.");
        return Control(request, (active, frame) =>
        {
            if (active.MicMuted == muted) return false;
            active.SetMicMuted(muted, frame);
            return true;
        });
    }

    public RecorderStatus Stop(ControlRequest request)
    {
        ValidateControlRequest(request);
        RecorderStatus status;
        lock (gate)
        {
            if (session is not { IsActive: true } active) return SnapshotLocked();
            var failed = request.Reason is "failure" or "application-quit-failure";
            status = EndLocked(active, failed ? "interrupted" : "stopped", null);
        }
        StatusChanged?.Invoke(this, status);
        return status;
    }

    public RecorderStatus Snapshot()
    {
        lock (gate) return SnapshotLocked();
    }

    private RecorderStatus SnapshotLocked() => session?.Status(clock.NowTicks) ?? IdleStatus;

    // Applies a pause or mute change at the current instant. change returns false for a no-op.
    private RecorderStatus Control(ControlRequest request, Func<CallSession, long, bool> change)
    {
        ValidateControlRequest(request);
        RecorderStatus status;
        lock (gate)
        {
            if (session is not { IsActive: true } active) throw new ProtocolException("not-recording", "No active capture session.");
            var now = clock.NowTicks;
            if (!change(active, active.Clock.FrameAt(now))) return active.Status(now);
            WriteSessionLocked(active, now);
            status = active.Status(now);
        }
        StatusChanged?.Invoke(this, status);
        return status;
    }

    private static string ValidateStart(StartRequest request)
    {
        if (!Guid.TryParseExact(request.SessionId, "D", out _)) throw new ProtocolException("invalid-session", "Session ID is invalid.");
        if (request.Microphone is not { Mode: "default" or "device" } microphone ||
            (microphone.Mode == "device" && string.IsNullOrWhiteSpace(microphone.DeviceId)))
            throw new ProtocolException("invalid-microphone", "Microphone selection is invalid.");
        if (string.IsNullOrWhiteSpace(request.SessionPath) || !Path.IsPathFullyQualified(request.SessionPath))
            throw new ProtocolException("invalid-session", "Session path must be absolute.");
        var fullPath = Path.GetFullPath(request.SessionPath);
        if (Directory.Exists(fullPath) && Directory.EnumerateFileSystemEntries(fullPath).Any())
            throw new ProtocolException("session-exists", "Session directory is not empty.");
        return fullPath;
    }

    private static void ValidateControlRequest(ControlRequest request)
    {
        if (request.RequestedAtUnixMs <= 0 || !double.IsFinite(request.RequestedAtMonotonicMs) || request.RequestedAtMonotonicMs <= 0)
            throw new ProtocolException("invalid-payload", "Control request time is invalid.");
    }

    private void OnDevicesChanged(object? sender, EventArgs eventArgs) => Interlocked.Exchange(ref devicesChanged, 1);

    public void Dispose()
    {
        RecorderStatus? status = null;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (session is { IsActive: true } active) status = EndLocked(active, "interrupted", null);
            StopLoop();
        }
        backend.DevicesChanged -= OnDevicesChanged;
        if (status is not null) StatusChanged?.Invoke(this, status);
    }
}
