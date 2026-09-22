using System.Text.Json;
using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

// The engine against fake sources, a hand-cranked clock and the real CallWriter on a temp
// directory. Sources emit one 10 ms packet per step; the timer ticks every 100 ms.
public sealed class RecorderEngineTests : IDisposable
{
    private const short MeValue = 8192;
    private const short ThemValue = -16384;
    private static readonly byte[] MePacket = Pcm.Int16(160, MeValue);
    private static readonly byte[] ThemPacket = Pcm.Int16(160, ThemValue);

    private readonly string root = Path.Combine(Path.GetTempPath(), "kern-engine-" + Guid.NewGuid().ToString("N"));
    private readonly FakeClock clock = new();
    private readonly FakeBackend backend = new();
    private readonly List<RecorderStatus> events = [];
    private readonly RecorderEngine engine;
    private long freeSpace = 50L * 1024 * 1024 * 1024;
    private FailingSink? sink;
    private int steps;

    public RecorderEngineTests()
    {
        engine = new RecorderEngine(backend, clock.Timeline, 4242, new RecorderEngineOptions
        {
            RunLoop = false,
            FreeSpace = _ => freeSpace,
            OpenSink = path => sink = new FailingSink(new CallWriter(path)),
        });
        engine.StatusChanged += (_, status) => events.Add(status);
    }

    private string SessionPath => Path.Combine(root, "session");

    [Fact]
    public void StartThenStopWritesContiguousAudioAndAFinalSessionJson()
    {
        var started = engine.Start(Request());
        Assert.Equal("recording", started.State);
        Assert.Equal("all-apps", started.PlaybackMode);
        Assert.Equal(["microphone", "playback"], started.Sources.Select(source => source.Id));
        Assert.Equal("recording", ReadSession().GetProperty("state").GetString());

        Run(TimeSpan.FromSeconds(3));
        var live = engine.Snapshot();
        Assert.InRange(live.CommittedFrames, 1, 3 * 16_000 - CommitLoop.HorizonFrames);
        Assert.All(live.Sources, source => Assert.Equal("active", source.State));
        Assert.All(live.Sources, source => Assert.Equal(0.25 * (source.Lane == "me" ? 1 : 2), source.Level));

        var stopped = engine.Stop(Control());

        Assert.Equal("stopped", stopped.State);
        Assert.Equal(48_000, stopped.CommittedFrames);
        var audio = File.ReadAllBytes(Path.Combine(SessionPath, "audio.pcm"));
        Assert.Equal(48_000 * CallAudio.BytesPerFrame, audio.Length);
        AssertSpan(audio, 0, 48_000, MeValue, ThemValue);
        var session = ReadSession();
        Assert.Equal("stopped", session.GetProperty("state").GetString());
        Assert.Equal(48_000, session.GetProperty("committedFrames").GetInt64());
        Assert.NotEqual(JsonValueKind.Null, session.GetProperty("endedAtUtc").ValueKind);
        Assert.Equal(2, session.GetProperty("producer").GetProperty("protocol").GetInt32());
        Assert.Equal(300, session.GetProperty("sources")[0].GetProperty("stats").GetProperty("packets").GetInt64());
        Assert.Equal(48_000, session.GetProperty("sources")[1].GetProperty("stats").GetProperty("outputFrames").GetInt64());
        Assert.Equal(0, session.GetProperty("pauses").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, session.GetProperty("failure").ValueKind);
        Assert.All(backend.Opened, source => Assert.True(source.Disposed));
        Assert.Equal("stopped", events[^1].State);
    }

    [Fact]
    public void StopCommitsThroughTheStopInstantPastTheHorizon()
    {
        engine.Start(Request());
        Run(TimeSpan.FromSeconds(5));
        Assert.True(engine.Snapshot().CommittedFrames <= 80_000 - CommitLoop.HorizonFrames);

        var stopped = engine.Stop(Control());

        Assert.Equal(80_000, stopped.CommittedFrames);
        AssertSpan(File.ReadAllBytes(Path.Combine(SessionPath, "audio.pcm")), 79_840, 80_000, MeValue, ThemValue);
    }

    [Fact]
    public void PauseAndMuteSilenceTheRightLaneForExactlyTheirSpan()
    {
        engine.Start(Request());
        Run(TimeSpan.FromSeconds(1));
        Assert.True(engine.SetMicMuted(true, Control()).MicMuted);
        Run(TimeSpan.FromSeconds(1));
        Assert.False(engine.SetMicMuted(false, Control()).MicMuted);
        Run(TimeSpan.FromSeconds(1));
        Assert.Equal("paused", engine.Pause(Control()).State);
        Assert.Equal("paused", ReadSession().GetProperty("state").GetString());
        Run(TimeSpan.FromSeconds(1));
        Assert.Equal("recording", engine.Resume(Control()).State);
        Run(TimeSpan.FromSeconds(1));
        engine.Stop(Control());

        var audio = File.ReadAllBytes(Path.Combine(SessionPath, "audio.pcm"));
        AssertSpan(audio, 0, 16_000, MeValue, ThemValue);
        AssertSpan(audio, 16_000, 32_000, 0, ThemValue);
        AssertSpan(audio, 32_000, 48_000, MeValue, ThemValue);
        AssertSpan(audio, 48_000, 64_000, 0, 0);
        AssertSpan(audio, 64_000, 80_000, MeValue, ThemValue);
        var pauses = ReadSession().GetProperty("pauses").EnumerateArray()
            .Select(pause => (pause.GetProperty("startFrame").GetInt64(), pause.GetProperty("endFrame").GetInt64(), pause.GetProperty("reason").GetString()))
            .ToList();
        Assert.Equal([(16_000L, 32_000L, "mute"), (48_000L, 64_000L, "user")], pauses);
    }

    [Fact]
    public void SuspendPausesUntilResumeAndDoesNotStackOnAUserPause()
    {
        engine.Start(Request());
        Run(TimeSpan.FromSeconds(1));
        engine.Pause(Control());
        Assert.Equal("paused", engine.Suspend(Control()).State);
        Run(TimeSpan.FromSeconds(1));
        engine.Resume(Control());
        Run(TimeSpan.FromSeconds(1));
        engine.Suspend(Control());
        Run(TimeSpan.FromSeconds(1));
        engine.Stop(Control());

        var session = ReadSession();
        Assert.Equal(["user", "suspend"], session.GetProperty("pauses").EnumerateArray().Select(pause => pause.GetProperty("reason").GetString()));
        // A suspend still open at stop is closed at the stop instant.
        Assert.Equal(64_000, session.GetProperty("pauses")[1].GetProperty("endFrame").GetInt64());
        Assert.Throws<ProtocolException>(() => engine.Resume(Control()));
    }

    [Fact]
    public void AFailingSourceRecoversEveryTwoSecondsWithoutStoppingTheSession()
    {
        engine.Start(Request());
        Run(TimeSpan.FromSeconds(1));
        backend.MicrophoneFailuresLeft = 2;
        backend.Microphone!.Fail(new IOException("Device invalidated."));
        Run(TimeSpan.FromMilliseconds(100));

        var recovering = engine.Snapshot();
        Assert.Equal("recording", recovering.State);
        Assert.Equal("recovering", recovering.Sources[0].State);
        Assert.Equal("Microphone disconnected. Reconnecting.", recovering.Warning);
        Assert.Equal("active", recovering.Sources[1].State);

        Run(TimeSpan.FromSeconds(4.9));
        var recovered = engine.Snapshot();
        Assert.Equal("active", recovered.Sources[0].State);
        Assert.Null(recovered.Warning);
        Assert.Equal(4, backend.MicrophoneRequests.Count);
        engine.Stop(Control());

        var audio = File.ReadAllBytes(Path.Combine(SessionPath, "audio.pcm"));
        AssertSpan(audio, 0, 16_000, MeValue, ThemValue);
        AssertSpan(audio, 17_600, 81_600, 0, ThemValue);
        AssertSpan(audio, 81_600, 96_000, MeValue, ThemValue);
        var stats = ReadSession().GetProperty("sources")[0].GetProperty("stats");
        Assert.Equal(1, stats.GetProperty("gaps").GetInt64());
    }

    [Fact]
    public void AMissingChosenMicrophoneFallsBackToTheDefaultAndReturnsWhenItCan()
    {
        backend.MissingMicrophones.Add("usb-mic");
        var started = engine.Start(Request(new MicrophoneSelection("device", "usb-mic")));
        Assert.Equal("Mic (default)", started.Sources[0].Name);
        Assert.Equal("Chosen microphone is unavailable. Recording from the default microphone.", started.Warning);

        backend.MissingMicrophones.Clear();
        backend.Microphone!.Fail(new IOException("Device invalidated."));
        Run(TimeSpan.FromMilliseconds(100));

        var status = engine.Snapshot();
        Assert.Equal("Mic (usb-mic)", status.Sources[0].Name);
        Assert.Null(status.Warning);
    }

    [Fact]
    public void AWriteFailureInterruptsTheSessionAndKeepsTheAudioAlreadyWritten()
    {
        engine.Start(Request());
        Run(TimeSpan.FromSeconds(3));
        sink!.FailAppends = true;
        Run(TimeSpan.FromMilliseconds(200));

        var status = engine.Snapshot();
        Assert.Equal("interrupted", status.State);
        Assert.Equal("write-failed", status.Failure!.Code);
        Assert.All(backend.Opened, source => Assert.True(source.Disposed));
        var session = ReadSession();
        Assert.Equal("interrupted", session.GetProperty("state").GetString());
        var committed = session.GetProperty("committedFrames").GetInt64();
        Assert.True(committed > 0);
        var audio = File.ReadAllBytes(Path.Combine(SessionPath, "audio.pcm"));
        Assert.Equal(committed * CallAudio.BytesPerFrame, audio.Length);
        AssertSpan(audio, 0, committed, MeValue, ThemValue);

        Assert.Equal("interrupted", engine.Stop(Control()).State);
        Assert.Throws<ProtocolException>(() => engine.Pause(Control()));
        Assert.Equal("recording", engine.Start(Request(path: Path.Combine(root, "next"))).State);
    }

    [Fact]
    public void LowDiskStopsCleanlyThroughTheStopInstant()
    {
        engine.Start(Request());
        Run(TimeSpan.FromSeconds(1));
        freeSpace = 10L * 1024 * 1024;
        Run(TimeSpan.FromSeconds(1));

        var status = engine.Snapshot();
        Assert.Equal("interrupted", status.State);
        Assert.Equal("low-storage", status.Failure!.Code);
        Assert.Equal(32_000, status.CommittedFrames);
        Assert.Equal(32_000 * CallAudio.BytesPerFrame, new FileInfo(Path.Combine(SessionPath, "audio.pcm")).Length);
    }

    [Fact]
    public void WithoutProcessLoopbackEveryActiveEndpointIsCapturedAndFollowed()
    {
        backend.ProcessLoopbackWorks = false;
        backend.Endpoints["{speakers}"] = "Speakers";
        backend.Endpoints["{airpods}"] = "Headphones (AirPods)";
        var started = engine.Start(Request());
        Assert.Equal("devices", started.PlaybackMode);
        Assert.Equal(3, started.Sources.Count);
        Assert.All(started.Sources.Skip(1), source => Assert.Equal("endpoint-loopback", source.Mode));
        Run(TimeSpan.FromSeconds(1));

        backend.Endpoints.Remove("{airpods}");
        backend.Endpoints["{hdmi}"] = "HDMI";
        backend.RaiseDevicesChanged();
        Run(TimeSpan.FromMilliseconds(100));
        var changed = engine.Snapshot();
        var airpods = changed.Sources.Single(source => source.Id == RecorderEngine.EndpointSourceId("{airpods}"));
        Assert.Equal("idle", airpods.State);
        Assert.Equal("Device is not connected.", airpods.Message);
        Assert.Equal(4, changed.Sources.Count);

        backend.Endpoints["{airpods}"] = "Headphones (AirPods)";
        backend.RaiseDevicesChanged();
        Run(TimeSpan.FromMilliseconds(500));
        var back = engine.Snapshot().Sources.Single(source => source.Id == airpods.Id);
        Assert.Equal("active", back.State);
        Assert.True(back.Stats.Packets > airpods.Stats.Packets);
        Assert.Equal(4, engine.Snapshot().Sources.Count);
    }

    [Fact]
    public void WithNoPlaybackDeviceTheSessionStillRecordsTheMicrophone()
    {
        backend.ProcessLoopbackWorks = false;
        var status = engine.Start(Request());
        Assert.Equal("recording", status.State);
        Assert.Equal("No playback device is available. Only the microphone is being recorded.", status.Warning);
    }

    [Fact]
    public void PublishesStatusEveryHalfSecondAndStaysFarBelowTheFrameLimit()
    {
        backend.ProcessLoopbackWorks = false;
        for (var endpoint = 0; endpoint < 64; endpoint++)
            backend.Endpoints[$"{{0.0.0.00000000}}.{{{Guid.NewGuid()}}}"] = $"Speakers ({new string('x', 60)}) {endpoint}";
        engine.Start(Request());
        events.Clear();
        Run(TimeSpan.FromSeconds(2));

        Assert.InRange(events.Count, 4, 5);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(events[^1], Protocol.JsonOptions);
        Assert.True(bytes.Length < Protocol.MaximumMessageBytes / 8, $"status was {bytes.Length} bytes");
    }

    [Fact]
    public void RejectsInvalidStartsAndCommandsWithoutASession()
    {
        Assert.Equal("idle", engine.Snapshot().State);
        Assert.Throws<ProtocolException>(() => engine.Pause(Control()));
        Assert.Throws<ProtocolException>(() => engine.Start(Request() with { SessionId = "not-a-guid" }));
        Assert.Throws<ProtocolException>(() => engine.Start(Request(new MicrophoneSelection("device", null))));
        Directory.CreateDirectory(SessionPath);
        File.WriteAllText(Path.Combine(SessionPath, "stray"), "x");
        Assert.Throws<ProtocolException>(() => engine.Start(Request()));
        freeSpace = 100L * 1024 * 1024;
        Assert.Throws<IOException>(() => engine.Start(Request(path: Path.Combine(root, "other"))));
        freeSpace = long.MaxValue;
        engine.Start(Request(path: Path.Combine(root, "third")));
        Assert.Throws<ProtocolException>(() => engine.Start(Request(path: Path.Combine(root, "fourth"))));
        Assert.Throws<ProtocolException>(() => engine.SetMicMuted(true, Control() with { Muted = false }));
    }

    private void Run(TimeSpan duration)
    {
        for (var step = 0; step < (int)Math.Round(duration.TotalMilliseconds / 10); step++)
        {
            clock.Advance(TimeSpan.FromMilliseconds(10));
            foreach (var source in backend.Live.ToList())
                source.Emit(source.Name.StartsWith("Mic", StringComparison.Ordinal) ? MePacket : ThemPacket);
            if (++steps % 10 == 0) engine.Tick();
        }
    }

    private StartRequest Request(MicrophoneSelection? microphone = null, string? path = null) =>
        new(Guid.NewGuid().ToString("D"), path ?? SessionPath, microphone ?? new MicrophoneSelection("default", null));

    private static ControlRequest Control() => new(1_790_000_000_000, 1_000);

    private JsonElement ReadSession() =>
        JsonDocument.Parse(File.ReadAllBytes(Path.Combine(SessionPath, "session.json"))).RootElement;

    private static void AssertSpan(byte[] audio, long from, long to, short me, short them)
    {
        for (var frame = from; frame < to; frame++)
        {
            var actual = Pcm.Frame(audio, frame);
            if (actual != (me, them)) Assert.Fail($"frame {frame} was {actual}, expected {(me, them)}");
        }
    }

    public void Dispose()
    {
        engine.Dispose();
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}
