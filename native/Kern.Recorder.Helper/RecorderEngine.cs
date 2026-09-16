using NAudio.CoreAudioApi;

namespace Kern.Recorder.Helper;

internal sealed class RecorderEngine : IDisposable
{
    private const long MinimumFreeBytes = 256L * 1024 * 1024;
    private const long MetadataReserveBytes = 64L * 1024 * 1024;
    private readonly object gate = new();
    private readonly AudioDevices devices;
    private readonly TimelineClock clock;
    private readonly CaptureFence fence = new();
    private readonly Func<string, long> availableFreeSpace;
    private readonly List<CaptureTrack> tracks = [];
    private readonly SemaphoreSlim reconcileGate = new(1, 1);
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
    {
        this.devices = devices;
        this.clock = clock;
        this.availableFreeSpace = availableFreeSpace ?? AvailableFreeSpace;
        devices.Changed += OnDevicesChanged;
    }

    public event EventHandler<RecorderStatus>? StatusChanged;

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
            store = new SessionStore(currentSessionPath, new SessionManifest
            {
                SessionId = request.SessionId,
                State = "starting",
                StartedAtUtc = startedAtUtc,
                TimelineFrequency = TimelineClock.Frequency,
                ManifestVersion = 2,
                TimelineOriginTicks = sessionOriginTicks,
                CaptureGeneration = fence.Generation,
            });
            sessionCancellation = new CancellationTokenSource();

            try
            {
                foreach (var renderDevice in devices.ActiveRenderDevices())
                    AddTrack(renderDevice, "render", request.SegmentDurationMs);
                AddTrack(devices.ResolveMicrophone(request.Microphone), "microphone", request.SegmentDurationMs);
                if (tracks.Count == 0) throw new ProtocolException("no-audio-devices", "No supported audio endpoint is available.");

                foreach (var track in tracks) track.Start();
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
                foreach (var track in tracks)
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
            foreach (var track in tracks) track.PauseAtFence(cutoff);
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
            foreach (var track in tracks) track.ResumeAtFence(cutoff);
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
            foreach (var track in tracks.Where(track => track.Kind == "microphone"))
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
                foreach (var track in tracks) track.PauseAtFence(cutoff);
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
                foreach (var track in tracks)
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
            failure);
    }

    private void AddTrack(MMDevice device, string kind, int segmentDurationMs)
    {
        if (tracks.Any(track => track.EndpointId == device.ID && track.Kind == kind && track.IsCapturing))
        {
            device.Dispose();
            return;
        }
        CaptureTrack? track = null;
        try
        {
            track = new CaptureTrack(
                device,
                kind,
                store is null ? throw new InvalidOperationException("Session store is unavailable.") : store.SessionPath,
                clock,
                segmentDurationMs,
                fence,
                devices.DefaultRoles(device.ID, device.DataFlow),
                segment => store.AddSegment(segment),
                OnTrackFailure);
            tracks.Add(track);
            store.AddTrack(track.ToManifest());
        }
        catch
        {
            track?.Dispose();
            if (track is null) device.Dispose();
            throw;
        }
    }

    private async Task HealthLoop(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
            {
                RecorderStatus status;
                lock (gate)
                {
                    if (state is "idle" or "stopped" or "interrupted") return;
                    status = SnapshotUnsafe();
                    if (status.FreeBytes is long freeBytes && freeBytes < MetadataReserveBytes)
                    {
                        _ = Task.Run(StopForLowStorage, CancellationToken.None);
                        return;
                    }
                    if (status.Tracks.Any(track => track.Health is "failed" or "unknown") && state == "recording")
                    {
                        state = "degraded";
                        PersistState();
                        status = SnapshotUnsafe();
                    }
                    else if (state == "degraded" && status.Tracks.All(track => track.Health is not "failed" and not "unknown"))
                    {
                        state = "recording";
                        failure = null;
                        PersistState();
                        status = SnapshotUnsafe();
                    }
                }
                StatusChanged?.Invoke(this, status);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    private void OnDevicesChanged(object? sender, EventArgs eventArgs) => _ = ReconcileDevicesAsync();

    private async Task ReconcileDevicesAsync()
    {
        if (!await reconcileGate.WaitAsync(0).ConfigureAwait(false)) return;
        try
        {
            lock (gate)
            {
                if (state is "idle" or "stopped" or "interrupted") return;
                var activeRenderIds = devices.ActiveRenderIds();
                var activeCaptureIds = devices.ActiveCaptureIds();
                var cutoff = clock.NowTicks;
                foreach (var track in tracks)
                {
                    track.UpdateDefaultRoles(devices.DefaultRoles(
                        track.EndpointId,
                        track.Kind == "render" ? DataFlow.Render : DataFlow.Capture));
                    var endpointIsActive = track.Kind == "render"
                        ? activeRenderIds.Contains(track.EndpointId)
                        : activeCaptureIds.Contains(track.EndpointId);
                    if (!track.IsRetired && !endpointIsActive)
                    {
                        var message = track.Kind == "render"
                            ? "Playback endpoint is no longer active."
                            : "Pinned microphone is no longer active.";
                        track.RetireEndpoint(cutoff, message);
                        store!.OpenGap(track.TrackId, "endpoint-unavailable", cutoff, fence.Generation, "measured");
                    }
                }

                foreach (var device in devices.ActiveRenderDevices())
                {
                    try
                    {
                        if (tracks.All(track => track.EndpointId != device.ID || track.Kind != "render" || !track.IsCapturing))
                        {
                            AddTrack(device, "render", activeSegmentDurationMs);
                            tracks[^1].Start();
                        }
                        else device.Dispose();
                    }
                    catch (Exception error)
                    {
                        device.Dispose();
                        failure = new { code = "endpoint-add-failed", message = error.Message };
                    }
                }
                PersistState();
                StatusChanged?.Invoke(this, SnapshotUnsafe());
            }
        }
        finally { reconcileGate.Release(); }
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

    private void OnTrackFailure(CaptureTrack track, Exception error)
    {
        lock (gate)
        {
            state = "degraded";
            failure = new { code = "track-failed", trackId = track.TrackId, message = error.Message };
            PersistState();
            StatusChanged?.Invoke(this, SnapshotUnsafe());
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
        foreach (var track in tracks) track.Dispose();
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
        reconcileGate.Dispose();
        sessionCancellation?.Dispose();
    }
}
