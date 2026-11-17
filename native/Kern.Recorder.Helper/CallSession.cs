namespace Kern.Recorder.Helper;

// Everything one recording owns, and the two views of it: session.json and the status event.
// Guarded by the engine lock; only the pipelines and the commit loop are touched off it.
internal sealed class CallSession : IDisposable
{
    // The only playback mode: loopback on every active render endpoint. Kept in the protocol so
    // the desktop can tell this helper from one that captured the far side another way.
    public const string DevicesMode = "devices";

    private readonly List<PauseEntry> pauses = [];
    private PauseEntry? openPause;
    private PauseEntry? openMute;
    private long? endedTicks;

    public CallSession(string id, string path, MicrophoneSelection microphone, SessionClock clock, ICallSink sink)
    {
        Id = id;
        Path = path;
        Microphone = microphone;
        Clock = clock;
        Mixer = new CallMixer();
        Commit = new CommitLoop(Mixer, sink);
        StartedAtUtc = DateTimeOffset.UtcNow.ToString("O");
    }

    public string Id { get; }
    public string Path { get; }
    public MicrophoneSelection Microphone { get; }
    public SessionClock Clock { get; }
    public CallMixer Mixer { get; }
    public CommitLoop Commit { get; }
    public SourceSet Sources { get; } = new();
    public string StartedAtUtc { get; }
    public string? EndedAtUtc { get; private set; }
    public string State { get; private set; } = "recording";
    public CaptureFailure? Failure { get; private set; }
    public bool IsActive => State is "recording" or "paused";
    public bool IsPaused => openPause is not null;
    public bool MicMuted => openMute is not null;
    // Set when the chosen microphone could not be opened and the default one is in use.
    public bool MicFallback { get; set; }
    public bool SessionFileFailing { get; set; }
    public long NextStatusTicks { get; set; }
    public long NextSessionWriteTicks { get; set; }
    public long NextHousekeepingTicks { get; set; }

    public void Pause(string reason, long frame)
    {
        openPause = Open(CallMixer.BothMask, reason, frame);
        State = "paused";
    }

    public void Resume(long frame)
    {
        Close(openPause, frame);
        openPause = null;
        State = "recording";
    }

    public void SetMicMuted(bool muted, long frame)
    {
        if (muted) openMute = Open(CallMixer.MeMask, "mute", frame);
        else
        {
            Close(openMute, frame);
            openMute = null;
        }
    }

    public void End(string state, CaptureFailure? failure, long frame, long nowTicks)
    {
        Close(openPause, frame);
        Close(openMute, frame);
        State = state;
        Failure = failure ?? Failure;
        endedTicks = nowTicks;
        EndedAtUtc = DateTimeOffset.UtcNow.ToString("O");
    }

    public SessionDocument Document(ProducerInfo producer, long nowTicks) => new(
        SessionDocument.FormatName, Id, State, StartedAtUtc, EndedAtUtc, CallAudio.SampleRate, CallAudio.Channels,
        CallAudio.LaneNames, Commit.CommittedFrames, producer, DevicesMode,
        Sources.Slots.Select(slot => slot.Record(nowTicks)).ToList(),
        pauses.Select(entry => new PauseSpan(entry.StartFrame, entry.EndFrame, entry.Reason)).ToList(),
        Failure);

    public RecorderStatus Status(long nowTicks) => new(
        State, Id, StartedAtUtc, Clock.ElapsedMilliseconds(endedTicks ?? nowTicks), Commit.CommittedFrames, MicMuted,
        DevicesMode, Sources.Slots.Select(slot => slot.Status(nowTicks)).ToList(), Failure, Warning());

    // The one thing the user should know right now, most important first.
    private string? Warning()
    {
        if (!IsActive) return null;
        var slots = Sources.Slots;
        if (slots.Any(slot => slot.Lane == CallAudio.MeLane && slot.State == SourceSlot.Condition.Recovering))
            return "Microphone disconnected. Reconnecting.";
        if (MicFallback) return "Chosen microphone is unavailable. Recording from the default microphone.";
        var playback = slots.Where(slot => slot.Lane == CallAudio.ThemLane).ToList();
        if (!playback.Any(slot => slot.State == SourceSlot.Condition.Open))
            return "No playback device is available. Only the microphone is being recorded.";
        if (SessionFileFailing) return "Recording details could not be saved. Audio is still being recorded.";
        if (slots.Any(slot => slot.Pipeline.Stats().DroppedFrames > 0)) return "Some audio could not be recorded.";
        return null;
    }

    private PauseEntry Open(int laneMask, string reason, long frame)
    {
        var entry = new PauseEntry(frame, reason, Mixer.OpenGate(laneMask, frame));
        pauses.Add(entry);
        return entry;
    }

    private void Close(PauseEntry? entry, long frame)
    {
        if (entry is null || entry.EndFrame is not null) return;
        Mixer.CloseGate(entry.GateId, frame);
        entry.EndFrame = Math.Max(entry.StartFrame, frame);
    }

    public void Dispose()
    {
        Sources.CloseAll();
        Commit.Dispose();
    }

    private sealed class PauseEntry(long startFrame, string reason, int gateId)
    {
        public long StartFrame { get; } = startFrame;
        public string Reason { get; } = reason;
        public int GateId { get; } = gateId;
        public long? EndFrame { get; set; }
    }
}
