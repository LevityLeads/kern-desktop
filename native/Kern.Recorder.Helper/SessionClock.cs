namespace Kern.Recorder.Helper;

// The fixed shape of audio.pcm: interleaved int16 stereo at 16 kHz, lane 0 "me", lane 1 "them".
internal static class CallAudio
{
    public const int SampleRate = 16_000;
    public const int Channels = 2;
    public const int BytesPerFrame = Channels * sizeof(short);
    public const int MeLane = 0;
    public const int ThemLane = 1;
    public static readonly IReadOnlyList<string> LaneNames = ["me", "them"];
}

// Maps process clock ticks and WASAPI QPC stamps onto session frames (16 kHz, frame 0 = origin).
internal sealed class SessionClock(TimelineClock clock, long originTicks)
{
    public long NowTicks => clock.NowTicks;
    public long NowFrame => FrameAt(clock.NowTicks);

    // Floor division so a tick just before a frame boundary never rounds into the next frame,
    // and ticks before the origin map to negative frames (the mixer shifts those forward).
    public long FrameAt(long ticks)
    {
        var product = (Int128)(ticks - originTicks) * CallAudio.SampleRate;
        var frame = product / TimelineClock.Frequency;
        if (product < 0 && product % TimelineClock.Frequency != 0) frame--;
        return (long)frame;
    }

    // Null when the stamp cannot be on this machine's QPC timeline at all; the aligner then
    // falls back to arrival time.
    public long? FrameAtQpc(long qpc100Nanoseconds)
    {
        if (qpc100Nanoseconds <= 0) return null;
        try
        {
            var frame = FrameAt(clock.FromQpc100Nanoseconds(qpc100Nanoseconds));
            // A real WASAPI stamp is for a sample already captured, so it never lies in the
            // future. Anything past now (with a second of slack for clock skew) cannot be on
            // this machine's QPC timeline; reject it rather than trust a garbage stamp that
            // happened to convert without overflowing.
            if (frame > NowFrame + CallAudio.SampleRate) return null;
            return frame;
        }
        catch (Exception error) when (error is OverflowException or ArgumentOutOfRangeException) { return null; }
    }

    public long ElapsedMilliseconds(long ticks) => TimelineClock.ElapsedMilliseconds(originTicks, ticks);
}
