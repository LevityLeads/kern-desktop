namespace Kern.Recorder.Helper;

internal sealed partial class RecorderEngine : IDisposable
{
    private const long MinimumFreeBytes = 256L * 1024 * 1024;
    private const long MetadataReserveBytes = 64L * 1024 * 1024;
    private readonly object gate = new();
    private readonly ICaptureBackend devices;
    private readonly TimelineClock clock;
    private readonly CaptureFence fence = new();
    private readonly Func<string, long> availableFreeSpace;
    private readonly List<ICaptureTrack> tracks = [];
    private SessionStore? store;
    private CancellationTokenSource? sessionCancellation;
    private Task? healthTask;
    private int activeSegmentDurationMs = 5000;
    private string state = "idle";
    private string? sessionId;
    private string? startedAtUtc;
    private string? pauseGapId;
    private string? muteGapId;
    private bool micMuted;
    private object? failure;
    private string? currentSessionPath;
    private bool disposed;
    private long sessionOriginTicks;

    public RecorderEngine(AudioDevices devices, TimelineClock clock, Func<string, long>? availableFreeSpace = null)
        : this(new WasapiCaptureBackend(devices), clock, availableFreeSpace) { }

    internal RecorderEngine(ICaptureBackend devices, TimelineClock clock, Func<string, long>? availableFreeSpace = null)
    {
        this.devices = devices;
        this.clock = clock;
        this.availableFreeSpace = availableFreeSpace ?? AvailableFreeSpace;
        devices.Changed += OnDevicesChanged;
    }

    public event EventHandler<RecorderStatus>? StatusChanged;

    public static string HelperVersion { get; } =
        typeof(RecorderEngine).Assembly.GetName().Version?.ToString() ?? "unknown";

    // Desktop build label passed on the command line; "unknown" when launched by hand.
    public string? AppBuild { get; init; }

    public DeviceList ListDevices() => devices.List();

    public RecorderStatus Start(StartRequest request)
    {
        lock (gate)
        {
            if (state != "idle") throw new ProtocolException("already-recording", "A capture session is already active.");
            ValidateStart(request);
            CheckStorage(request.SessionPath);
            state = "starting";
            sessionId = request.SessionId;
            startedAtUtc = DateTimeOffset.UtcNow.ToString("O");
            fence.Generation = 1;
            fence.PersistAll = true;
            fence.PersistMicrophone = true;
            micMuted = false;
            failure = null;
            currentSessionPath = Path.GetFullPath(request.SessionPath);
            activeSegmentDurationMs = request.SegmentDurationMs;
            sessionOriginTicks = clock.NowTicks;
            DeviceList? devicesAtStart = null;
            try { devicesAtStart = devices.List(); }
            catch { /* Diagnostic only; a device enumeration hiccup must not stop a recording. */ }
            store = new SessionStore(currentSessionPath, new SessionManifest
            {
                SessionId = request.SessionId,
                State = "starting",
                StartedAtUtc = startedAtUtc,
                TimelineFrequency = TimelineClock.Frequency,
                ManifestVersion = 2,
                TimelineOriginTicks = sessionOriginTicks,
                CaptureGeneration = fence.Generation,
                Producer = new ProducerInfo(AppBuild ?? "unknown", HelperVersion, Protocol.Version),
                DevicesAtStart = devicesAtStart,
            });
            sessionCancellation = new CancellationTokenSource();

            try
            {
                pinnedMicrophoneId = devices.ResolveMicrophoneId(request.Microphone);
                skippedRenderEndpoints.Clear();
                foreach (var endpointId in devices.RenderIds())
                {
                    // One playback endpoint refusing loopback (a virtual driver, an exclusive-mode
                    // stream) must not stop the call from being recorded on the ones that work.
                    ICaptureTrack track;
                    try { track = OpenTrack(endpointId, "render", request.SegmentDurationMs); }
                    catch (Exception error)
                    {
                        SkipRenderEndpoint(endpointId, error.Message);
                        continue;
                    }
                    RegisterTrack(track);
                }
                AddTrack(pinnedMicrophoneId, "microphone", request.SegmentDurationMs);
                if (tracks.Count == 0) throw new ProtocolException("no-audio-devices", "No supported audio endpoint is available.");

                foreach (var track in tracks.Where(track => !track.IsRetired).ToArray())
                {
                    try { track.Start(); }
                    catch (Exception error) when (track.Kind == "render")
                    {
                        SkipRenderEndpoint(track.EndpointId, error.Message);
                        try { track.RetireEndpoint(clock.NowTicks, error.Message); } catch { }
                        track.Dispose();
                    }
                }
                if (!tracks.Any(track => !track.IsRetired)) throw new ProtocolException("no-audio-devices", "No audio endpoint could be started.");
                devicesChanged = true;
                state = "recording";
                store.SetState(state, 0, micMuted, fence.Generation);
                healthTask = Task.Run(() => HealthLoop(sessionCancellation.Token));
                var status = SnapshotUnsafe();
                StatusChanged?.Invoke(this, status);
                return status;
            }
            catch (Exception error)
            {
                lock (fence.SyncRoot)
                {
                    fence.PersistAll = false;
                    fence.Generation++;
                }
                var cutoff = clock.NowTicks;
                foreach (var track in tracks.Where(track => !track.IsRetired))
                {
                    try { track.Stop(cutoff); }
                    catch { }
                }
                state = "interrupted";
                failure = new { code = "start-failed", message = error.Message };
                store.SetState(state, TimelineClock.ElapsedMilliseconds(sessionOriginTicks, cutoff), micMuted, fence.Generation, failure);
                DisposeTracks();
                throw;
            }
        }
    }

    public RecorderStatus Pause(ControlRequest request)
    {
        ValidateControlRequest(request);
        lock (gate)
        lock (fence.SyncRoot)
        {
            RequireActive();
            if (state is "paused" or "suspended") return SnapshotUnsafe();
            var cutoff = clock.NowTicks;
            fence.PersistAll = false;
            fence.Generation++;
            foreach (var track in tracks.Where(track => !track.IsRetired)) track.PauseAtFence(cutoff);
            pauseGapId = store!.OpenGap("all", "user-pause", cutoff, fence.Generation).GapId;
            state = "paused";
            PersistState(cutoff, request);
            return PublishStatus(cutoff);
        }
    }

    public RecorderStatus Resume(ControlRequest request)
    {
        ValidateControlRequest(request);
        lock (gate)
        lock (fence.SyncRoot)
        {
            RequireActive();
            if (state != "paused" && state != "suspended")
                throw new ProtocolException("invalid-state", "Recording is not paused.");
            var cutoff = clock.NowTicks;
            if (pauseGapId is not null) store!.CloseGap(pauseGapId, cutoff);
            pauseGapId = null;
            fence.Generation++;
            fence.PersistAll = true;
            foreach (var track in tracks.Where(track => !track.IsRetired)) track.ResumeAtFence(cutoff);
            state = "recording";
            PersistState(cutoff, request);
            return PublishStatus(cutoff);
        }
    }

    public RecorderStatus SetMicMuted(bool muted, ControlRequest request)
    {
        ValidateControlRequest(request);
        if (request.Muted is not null && request.Muted != muted)
            throw new ProtocolException("invalid-payload", "Microphone mute payload does not match the command.");
        lock (gate)
        lock (fence.SyncRoot)
        {
            RequireActive();
            if (micMuted == muted) return SnapshotUnsafe();
            var cutoff = clock.NowTicks;
            fence.Generation++;
            fence.PersistMicrophone = !muted;
            micMuted = muted;
            foreach (var track in tracks.Where(track => !track.IsRetired && track.Kind == "microphone"))
                track.ApplyMicrophoneFence(!muted, cutoff, "Kern microphone is muted.");
            if (muted)
                muteGapId = store!.OpenGap("microphone", "user-mic-mute", cutoff, fence.Generation).GapId;
            else if (muteGapId is not null)
            {
                store!.CloseGap(muteGapId, cutoff);
                muteGapId = null;
            }
            PersistState(cutoff, request);
            return PublishStatus(cutoff);
        }
    }

    public RecorderStatus Suspend(ControlRequest request)
    {
        ValidateControlRequest(request);
        lock (gate)
        lock (fence.SyncRoot)
        {
            RequireActive();
            if (state == "suspended") return SnapshotUnsafe();
            var cutoff = clock.NowTicks;
            if (state != "paused")
            {
                fence.PersistAll = false;
                fence.Generation++;
                foreach (var track in tracks.Where(track => !track.IsRetired)) track.PauseAtFence(cutoff);
                pauseGapId = store!.OpenGap("all", "system-suspend", cutoff, fence.Generation).GapId;
            }
            state = "suspended";
            PersistState(cutoff, request);
            return PublishStatus(cutoff);
        }
    }

    public RecorderStatus Stop(ControlRequest request)
    {
        ValidateControlRequest(request);
        lock (gate)
        {
            if (state == "idle" || state == "stopped") return SnapshotUnsafe();
            long cutoff;
            var interrupted = request.Reason is "failure" or "application-quit-failure";
            state = interrupted ? "interrupted" : "stopped";
            lock (fence.SyncRoot)
            {
                cutoff = clock.NowTicks;
                fence.PersistAll = false;
                fence.Generation++;
                foreach (var track in tracks.Where(track => !track.IsRetired))
                {
                    try { track.Stop(cutoff); }
                    catch (Exception error)
                    {
                        state = "interrupted";
                        failure = new { code = "stop-failed", trackId = track.TrackId, message = error.Message };
                    }
                }
            }
            if (pauseGapId is not null) store!.CloseGap(pauseGapId, cutoff);
            if (muteGapId is not null) store!.CloseGap(muteGapId, cutoff);
            CloseRecoveryGaps(cutoff);
            PersistState(cutoff, request);
            sessionCancellation?.Cancel();
            var result = PublishStatus(cutoff);
            DisposeTracks();
            return result;
        }
    }

    public SessionManifest Recover(RecoverRequest request)
    {
        lock (gate)
        {
            if (state != "idle" && state != "stopped") throw new ProtocolException("already-recording", "Stop capture before recovery.");
            return SessionStore.Open(request.SessionPath, request.SessionId).Recover();
        }
    }

    public RecorderStatus Snapshot()
    {
        lock (gate) return SnapshotUnsafe();
    }

    private RecorderStatus SnapshotUnsafe()
    {
        var now = clock.NowTicks;
        long? freeBytes = null;
        if (currentSessionPath is not null)
        {
            try { freeBytes = availableFreeSpace(currentSessionPath); }
            catch { }
        }
        return new RecorderStatus(
            state,
            sessionId,
            micMuted,
            startedAtUtc,
            TimelineClock.ElapsedMilliseconds(sessionOriginTicks, now),
            freeBytes,
            tracks.Select(track => track.Status(now)).ToList(),
            failure,
            state == "recording" && (tracks.Any(t => t.IsRetired && !skippedRenderEndpoints.Contains(t.EndpointId)) ||
                tracks.Any(t => t.Status(now).DroppedFrames > 0))
                ? "Recording continues. Some earlier audio is missing."
                : null);
    }

    private ICaptureTrack AddTrack(string endpointId, string kind, int segmentDurationMs)
    {
        var track = OpenTrack(endpointId, kind, segmentDurationMs);
        RegisterTrack(track);
        return track;
    }

    // Opening the device and registering it with the session are separate steps so a device
    // that refuses to open is reported as skipped, while a session-store failure stays fatal.
    private ICaptureTrack OpenTrack(string endpointId, string kind, int segmentDurationMs) =>
        devices.CreateTrack(endpointId, kind,
            store is null ? throw new InvalidOperationException("Session store is unavailable.") : store.SessionPath,
            clock, segmentDurationMs, fence, segment => store.AddSegment(segment), OnTrackFailure);

    private void RegisterTrack(ICaptureTrack track)
    {
        try
        {
            store!.AddTrack(track.ToManifest());
            tracks.Add(track);
        }
        catch { track.Dispose(); throw; }
    }

    private void SkipRenderEndpoint(string endpointId, string reason)
    {
        skippedRenderEndpoints.Add(endpointId);
        store!.AddSkippedEndpoint(new SkippedEndpoint(endpointId, "render", reason));
    }

    // Consecutive failed ticks (250 ms apart) before a metadata persistence problem
    // is reported. Audio writers are independent of manifest persistence, so a
    // transient replace failure must neither end supervision nor degrade the session.
    internal const int HealthFaultThreshold = 8;

    private async Task HealthLoop(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        var faults = 0;
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
            {
                try
                {
                    if (!HealthTick()) return;
                    faults = 0;
                }
                catch (Exception error)
                {
                    if (++faults < HealthFaultThreshold) continue;
                    lock (gate)
                    {
                        if (state is "idle" or "stopped" or "interrupted") return;
                        if (state == "recording") state = "degraded";
                        failure = new { code = "capture-health-failed", message = $"Recording metadata could not be saved: {error.Message}" };
                        StatusChanged?.Invoke(this, SnapshotUnsafe());
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    // One supervision pass. Returns false when the session has ended.
    internal bool HealthTick()
    {
        CheckRecovery();
        RecorderStatus status;
        lock (gate)
        {
            if (state is "idle" or "stopped" or "interrupted") return false;
            status = SnapshotUnsafe();
            if (status.FreeBytes is long freeBytes && freeBytes < MetadataReserveBytes)
            {
                _ = Task.Run(StopForLowStorage, CancellationToken.None);
                return false;
            }
            if (HasActiveCaptureFailure(clock.NowTicks) && state == "recording")
            {
                state = "degraded";
                PersistState();
                status = SnapshotUnsafe();
            }
            else if (state == "degraded" && !HasActiveCaptureFailure(clock.NowTicks))
            {
                state = "recording";
                failure = null;
                PersistState();
                status = SnapshotUnsafe();
            }
        }
        StatusChanged?.Invoke(this, status);
        return true;
    }

    private void StopForLowStorage()
    {
        try
        {
            lock (gate)
            {
                if (state is "idle" or "stopped" or "interrupted") return;
                failure = new
                {
                    code = "low-storage",
                    message = "Recording stopped before free space fell below the metadata and recovery reserve.",
                };
            }
            Stop(new ControlRequest(
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                System.Diagnostics.Stopwatch.GetTimestamp() * 1000d / System.Diagnostics.Stopwatch.Frequency,
                Reason: "failure"));
        }
        catch (Exception error)
        {
            lock (gate)
            {
                state = "interrupted";
                failure = new { code = "low-storage-stop-failed", message = error.Message };
                PersistState();
                StatusChanged?.Invoke(this, SnapshotUnsafe());
            }
        }
    }


    private static void ValidateStart(StartRequest request)
    {
        if (!Guid.TryParseExact(request.SessionId, "D", out _)) throw new ProtocolException("invalid-session", "Session ID is invalid.");
        if (request.SegmentDurationMs is < 1000 or > 30_000) throw new ProtocolException("invalid-segment-duration", "Segment duration is invalid.");
        var fullPath = Path.GetFullPath(request.SessionPath);
        if (Directory.Exists(fullPath) && Directory.EnumerateFileSystemEntries(fullPath).Any())
            throw new ProtocolException("session-exists", "Session directory is not empty.");
    }

    private static void ValidateControlRequest(ControlRequest request)
    {
        if (request.RequestedAtUnixMs <= 0 || !double.IsFinite(request.RequestedAtMonotonicMs) || request.RequestedAtMonotonicMs <= 0)
            throw new ProtocolException("invalid-payload", "Control request time is invalid.");
    }

    private static long AvailableFreeSpace(string sessionPath)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(sessionPath)) ?? throw new IOException("Recording path has no drive.");
        return new DriveInfo(root).AvailableFreeSpace;
    }

    private static void CheckStorage(string sessionPath)
    {
        var root = Path.GetPathRoot(Path.GetFullPath(sessionPath)) ?? throw new IOException("Recording path has no drive.");
        var drive = new DriveInfo(root);
        if (!drive.IsReady || drive.AvailableFreeSpace < MinimumFreeBytes)
            throw new IOException("At least 256 MB of free disk space is required to start recording.");
        var parentPath = Path.GetDirectoryName(Path.GetFullPath(sessionPath)) ?? throw new IOException("Recording path has no parent.");
        Directory.CreateDirectory(parentPath);
        WindowsNative.ExcludeFromContentIndexing(parentPath);
        var probe = Path.Combine(parentPath, $".kern-write-{Guid.NewGuid():N}.tmp");
        File.WriteAllBytes(probe, [0x4b]);
        File.Delete(probe);
    }

    private void PersistState(long? effectiveCutoffTicks = null, ControlRequest? request = null)
    {
        if (store is null) return;
        foreach (var track in tracks)
        {
            var manifestTrack = store.Manifest.Tracks.FirstOrDefault(candidate => candidate.TrackId == track.TrackId);
            if (manifestTrack is null) continue;
            var status = track.Status(clock.NowTicks);
            manifestTrack.Health = status.Health;
            manifestTrack.Message = status.Message;
            manifestTrack.DefaultRoles = status.DefaultRoles;
            manifestTrack.Generation = track.Generation;
            manifestTrack.Counters = status.Counters;
        }
        store.SetState(
            state,
            TimelineClock.ElapsedMilliseconds(sessionOriginTicks, clock.NowTicks),
            micMuted,
            fence.Generation,
            failure,
            request?.RequestedAtUnixMs,
            request?.RequestedAtMonotonicMs,
            effectiveCutoffTicks);
    }

    private RecorderStatus PublishStatus(long cutoff)
    {
        var status = SnapshotUnsafe() with { EffectiveCutoffTicks = cutoff };
        StatusChanged?.Invoke(this, status);
        return status;
    }

    private void RequireActive()
    {
        if (state is "idle" or "stopped" or "interrupted") throw new ProtocolException("not-recording", "No active capture session.");
    }

    private void DisposeTracks()
    {
        foreach (var track in tracks.Where(track => !track.IsRetired)) track.Dispose();
        tracks.Clear();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        sessionCancellation?.Cancel();
        try
        {
            if (state is not "idle" and not "stopped" and not "interrupted")
            {
                Stop(new ControlRequest(
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    System.Diagnostics.Stopwatch.GetTimestamp() * 1000d / System.Diagnostics.Stopwatch.Frequency,
                    Reason: "failure"));
            }
        }
        catch { }
        DisposeTracks();
        devices.Changed -= OnDevicesChanged;
        sessionCancellation?.Dispose();
    }
}
