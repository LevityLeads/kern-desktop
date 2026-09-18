using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class RecorderRecoveryTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "kern-device-recovery-" + Guid.NewGuid().ToString("N"));
    private static ControlRequest Control() => new(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), 1);

    [Fact]
    public async Task SameOutputFailureReopensAndRetiredHealthDoesNotPoisonRecovery()
    {
        var backend = new FakeBackend();
        using var engine = Start(backend);
        var old = backend.Created.Single(t => t.Kind == "render");
        old.Fail();
        Assert.Equal("degraded", engine.Snapshot().State);
        engine.CheckRecovery();
        var replacement = backend.Created.Last(t => t.Kind == "render");
        Assert.NotSame(old, replacement);
        Assert.Equal(old.EndpointId, replacement.EndpointId);
        replacement.EmitPacket();
        engine.CheckRecovery();
        await WaitUntil(() => engine.Snapshot().State == "recording");
        Assert.True(old.Disposed);
        engine.Stop(Control());
        var manifest = SessionStore.Open(root, backend.SessionId!).Manifest;
        Assert.All(manifest.Gaps, gap => Assert.NotNull(gap.EndTicks));
    }

    [Fact]
    public void MicrophoneReconnectNeverSubstitutesDefaultAndHonoursPauseMute()
    {
        var backend = new FakeBackend();
        using var engine = Start(backend);
        engine.SetMicMuted(true, Control());
        engine.Pause(Control());
        backend.CaptureIds = ["airpods-mic"];
        backend.Notify();
        engine.CheckRecovery();
        Assert.Single(backend.Created, t => t.Kind == "microphone");
        backend.CaptureIds.Add("fifine");
        backend.Notify();
        engine.CheckRecovery();
        var mic = backend.Created.Last(t => t.Kind == "microphone");
        Assert.Equal("fifine", mic.EndpointId);
        Assert.False(mic.PersistAtStart);
        Assert.True(mic.Paused);
        Assert.True(mic.Muted);
        Assert.Equal("paused", engine.Snapshot().State);
        engine.Stop(Control());
    }

    [Fact]
    public void DefaultPlaybackSwitchRetiresOldTrackAndStartsOnlyNewDefault()
    {
        var backend = new FakeBackend();
        using var engine = Start(backend);
        var old = backend.Created[0];
        backend.RenderIds = ["speakers"];
        backend.Notify();
        engine.CheckRecovery();
        Assert.True(old.IsRetired);
        Assert.Equal("speakers", backend.Created[^1].EndpointId);
        Assert.Single(backend.Created, t => t.Kind == "render" && t.IsCapturing);
        engine.Stop(Control());
    }

    [Fact]
    public void UnexpectedStoppedCaptureIsRecoveredWithoutDeviceNotification()
    {
        var backend = new FakeBackend();
        using var engine = Start(backend);
        engine.CheckRecovery();
        var old = backend.Created[0];
        old.Stop(0);
        engine.CheckRecovery();
        Assert.Equal(3, backend.Created.Count);
        Assert.True(old.IsRetired);
        Assert.True(backend.Created[^1].IsCapturing);
        engine.Stop(Control());
    }

    [Fact]
    public void StopCancelsRecoveryAndLateFailuresCannotReviveSession()
    {
        var backend = new FakeBackend();
        using var engine = Start(backend);
        var old = backend.Created[0];
        old.Fail();
        engine.Stop(Control());
        var count = backend.Created.Count;
        backend.Notify();
        old.Fail();
        engine.CheckRecovery();
        Assert.Equal(count, backend.Created.Count);
        Assert.Equal("stopped", engine.Snapshot().State);
    }

    [Fact]
    public void StorageFailureDoesNotEnterDeviceRestartLoop()
    {
        var backend = new FakeBackend();
        using var engine = Start(backend);
        var old = backend.Created[0];
        old.HasWriterFailure = true;
        old.Fail();
        for (var i = 0; i < 10; i++) { backend.Notify(); engine.CheckRecovery(); }
        Assert.Equal(2, backend.Created.Count);
        engine.Stop(Control());
    }

    [Fact]
    public void FailedReopenIsBackedOffAndNeverLeavesTwoActiveTracks()
    {
        var backend = new FakeBackend();
        using var engine = Start(backend);
        backend.Created[0].Fail();
        backend.RejectOpen = true;
        engine.CheckRecovery();
        var attempts = backend.OpenAttempts;
        for (var i = 0; i < 10; i++) engine.CheckRecovery();
        Assert.Equal(attempts, backend.OpenAttempts);
        Assert.DoesNotContain(backend.Created, t => t.Kind == "render" && t.IsCapturing);
        engine.Stop(Control());
    }

    [Fact]
    public void RecoveryStopsAfterSixAttemptsUntilDeviceNotification()
    {
        long ticks = 0;
        var backend = new FakeBackend();
        using var engine = Start(backend, new TimelineClock(() => ticks));
        engine.CheckRecovery();
        backend.Created[0].Fail();
        backend.RejectOpen = true;
        for (var index = 0; index < 20; index++)
        {
            ticks += 30 * TimelineClock.Frequency;
            engine.CheckRecovery();
        }
        Assert.Equal(8, backend.OpenAttempts); // Two originals, six recovery attempts.
        backend.Notify();
        engine.CheckRecovery();
        Assert.Equal(9, backend.OpenAttempts);
        engine.Stop(Control());
    }

    private RecorderEngine Start(FakeBackend backend, TimelineClock? clock = null)
    {
        var engine = new RecorderEngine(backend, clock ?? new TimelineClock(), _ => 1024L * 1024 * 1024);
        backend.SessionId = Guid.NewGuid().ToString("D");
        engine.Start(new StartRequest(backend.SessionId, root, new MicrophoneSelection("device", "fifine"), 5000));
        return engine;
    }
    private static async Task WaitUntil(Func<bool> predicate)
    {
        for (var i = 0; i < 50 && !predicate(); i++) await Task.Delay(20);
        Assert.True(predicate());
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }

    private sealed class FakeBackend : ICaptureBackend
    {
        public event EventHandler? Changed;
        public List<FakeTrack> Created { get; } = [];
        public HashSet<string> CaptureIds { get; set; } = ["fifine", "airpods-mic"];
        public HashSet<string> RenderIds { get; set; } = ["airpods-output"];
        public string? SessionId;
        public bool RejectOpen;
        public int OpenAttempts;
        public void Notify() => Changed?.Invoke(this, EventArgs.Empty);
        public DeviceList List() => new([], []);
        public HashSet<string> DefaultRenderIds() => RenderIds;
        public HashSet<string> ActiveCaptureIds() => CaptureIds;
        public string ResolveMicrophoneId(MicrophoneSelection selection) => selection.DeviceId ?? "fifine";
        public IReadOnlyList<string> DefaultRoles(string id, string kind) => ["multimedia"];
        public ICaptureTrack CreateTrack(string endpointId, string kind, string sessionPath, TimelineClock clock,
            int segmentDurationMs, CaptureFence fence, Action<SegmentManifest> onSegment, Action<ICaptureTrack, Exception> onFailure)
        {
            OpenAttempts++;
            if (RejectOpen) throw new IOException("Endpoint unavailable");
            var track = new FakeTrack(endpointId, kind, fence, clock, onFailure);
            Created.Add(track);
            return track;
        }
    }

    private sealed class FakeTrack(string endpointId, string kind, CaptureFence fence, TimelineClock clock,
        Action<ICaptureTrack, Exception> onFailure) : ICaptureTrack
    {
        public string TrackId { get; } = Guid.NewGuid().ToString("N");
        public string EndpointId => endpointId;
        public string Kind => kind;
        public long Generation => fence.Generation;
        public bool IsRetired { get; private set; }
        public bool IsCapturing { get; private set; }
        public bool HasWriterFailure { get; set; }
        public bool PersistAtStart, Paused, Muted, Disposed;
        private bool emitted;
        public void Fail() { IsCapturing = false; onFailure(this, new IOException("Device invalidated")); }
        public void EmitPacket() => emitted = true;
        public void Start() { IsCapturing = true; PersistAtStart = fence.PersistAll && (kind != "microphone" || fence.PersistMicrophone); }
        public void Stop(long cutoffTicks) => IsCapturing = false;
        public void PauseAtFence(long cutoffTicks) => Paused = true;
        public void ResumeAtFence(long cutoffTicks) => Paused = false;
        public void ApplyMicrophoneFence(bool enabled, long cutoffTicks, string reason) => Muted = !enabled;
        public void UpdateDefaultRoles(IReadOnlyList<string> roles) { }
        public void RetireEndpoint(long cutoffTicks, string reason) { IsRetired = true; IsCapturing = false; }
        public TrackManifest ToManifest() => new() { TrackId = TrackId, EndpointId = endpointId, Name = endpointId,
            Kind = kind, DefaultRoles = [], Format = new(48000, 2, 16, 4, 192000, "pcm", null, null, null) };
        public TrackStatus Status(long nowTicks) => new(TrackId, endpointId, kind,
            IsRetired ? "failed" : emitted ? "capturing-signal" : "healthy-idle", 0, emitted ? 480 : 0, 0, clock.NowTicks, 0, [], null, IsRetired);
        public void Dispose() => Disposed = true;
    }
}
