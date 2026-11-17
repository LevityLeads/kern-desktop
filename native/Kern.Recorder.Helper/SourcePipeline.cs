using NAudio.Wave;

namespace Kern.Recorder.Helper;

// Everything one source's capture callback does: convert, place, sum. It outlives reopened
// streams (a new stream gets a fresh converter, the timeline cursor and counters carry on)
// and never touches the disk, so a slow write can never back up into a capture thread.
internal sealed class SourcePipeline(int lane, SessionClock clock, CallMixer mixer)
{
    private static readonly long LevelHoldTicks = TimelineClock.Frequency / 2;

    private readonly object gate = new();
    private readonly StreamAligner aligner = new();
    private SourceConverter? converter;
    private long packets;
    private long inputFrames;
    private long outputFrames;
    private long lateFrames;
    private long droppedFrames;
    private double level;
    private long? lastPacketTicks;

    public int Lane { get; } = lane;

    public void Bind(WaveFormat format)
    {
        var fresh = new SourceConverter(format);
        lock (gate) converter = fresh;
    }

    public void Unbind()
    {
        lock (gate) converter = null;
    }

    public void Accept(ReadOnlySpan<byte> buffer, bool silent, long? qpc100Nanoseconds)
    {
        var arrivedTicks = clock.NowTicks;
        lock (gate)
        {
            if (converter is null) return;
            var samples = converter.Convert(buffer, silent);
            packets++;
            inputFrames += buffer.Length / converter.BlockAlign;
            lastPacketTicks = arrivedTicks;
            level = Peak(samples);
            if (samples.IsEmpty) return;
            var qpcFrame = qpc100Nanoseconds is long qpc ? clock.FrameAtQpc(qpc) : null;
            var start = aligner.Place(samples.Length, clock.FrameAt(arrivedTicks), qpcFrame);
            var placed = mixer.Add(Lane, start, samples);
            aligner.Accept(placed.Start, samples.Length);
            outputFrames += samples.Length;
            lateFrames += placed.LateFrames;
            droppedFrames += placed.DroppedFrames;
        }
    }

    public SourceStats Stats()
    {
        lock (gate)
            return new SourceStats(packets, inputFrames, outputFrames, aligner.Gaps, aligner.GapFramesTotal,
                lateFrames, aligner.Resyncs, droppedFrames);
    }

    // A meter that froze on the last loud packet would claim a dead source is live.
    public double Level(long nowTicks)
    {
        lock (gate) return lastPacketTicks is long last && nowTicks - last <= LevelHoldTicks ? level : 0;
    }

    public long? LastPacketTicks
    {
        get { lock (gate) return lastPacketTicks; }
    }

    private static double Peak(ReadOnlySpan<float> samples)
    {
        var peak = 0f;
        foreach (var sample in samples) peak = Math.Max(peak, Math.Abs(sample));
        return Math.Round(Math.Min(peak, 1f), 3);
    }
}
