using System.Buffers.Binary;

namespace Kern.Recorder.Helper;

internal readonly record struct MixResult(long Start, long LateFrames, int DroppedFrames);

// Two float lanes on the session timeline, covering [committed, committed + capacity). Sources
// sum into it from their capture threads; the commit loop drains finished frames as int16.
// The lock guards only summing and draining, so a capture thread never waits on the disk.
internal sealed class CallMixer
{
    public const int DefaultCapacityFrames = CallAudio.SampleRate * 10;
    public const int MeMask = 1 << CallAudio.MeLane;
    public const int ThemMask = 1 << CallAudio.ThemLane;
    public const int BothMask = MeMask | ThemMask;

    private readonly object gate = new();
    private readonly float[][] lanes;
    private readonly int capacity;
    private readonly List<GateSpan> gates = [];
    private long committed;
    private int nextGateId;

    public CallMixer(int capacityFrames = DefaultCapacityFrames)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(capacityFrames, 1);
        capacity = capacityFrames;
        lanes = [new float[capacityFrames], new float[capacityFrames]];
    }

    // Late audio (starting before the committed edge) is moved forward rather than discarded:
    // a Bluetooth packet that arrives 2 s late is still speech someone said. Only audio past the
    // ring end is dropped, which needs the wall clock and the source to disagree by ~8 s.
    public MixResult Add(int lane, long start, ReadOnlySpan<float> samples)
    {
        lock (gate)
        {
            var late = 0L;
            if (start < committed)
            {
                late = committed - start;
                start = committed;
            }
            var accepted = (int)Math.Clamp(committed + capacity - start, 0, samples.Length);
            if (accepted > 0)
            {
                var ring = lanes[lane];
                var index = (int)(start % capacity);
                var first = Math.Min(accepted, capacity - index);
                Sum(ring.AsSpan(index, first), samples[..first]);
                Sum(ring.AsSpan(0, accepted - first), samples[first..accepted]);
            }
            return new MixResult(start, late, samples.Length - accepted);
        }
    }

    // Drains [committed, throughFrame) as interleaved int16, at most destination.Length / 4
    // frames per call so a long catch-up (after a stall) is written in bounded chunks.
    public int TakeCommitted(long throughFrame, Span<byte> destination)
    {
        lock (gate)
        {
            var count = (int)Math.Min(throughFrame - committed, destination.Length / CallAudio.BytesPerFrame);
            if (count <= 0) return 0;
            SilenceGatedSpans(committed, committed + count);
            var me = lanes[CallAudio.MeLane];
            var them = lanes[CallAudio.ThemLane];
            for (var frame = 0; frame < count; frame++)
            {
                var index = (int)((committed + frame) % capacity);
                var offset = frame * CallAudio.BytesPerFrame;
                BinaryPrimitives.WriteInt16LittleEndian(destination[offset..], ToPcm16(me[index]));
                BinaryPrimitives.WriteInt16LittleEndian(destination[(offset + 2)..], ToPcm16(them[index]));
                me[index] = 0;
                them[index] = 0;
            }
            committed += count;
            gates.RemoveAll(span => span.End <= committed);
            return count;
        }
    }

    // Pause and mute are spans on the timeline, not a flag checked at arrival: a packet that
    // was already summed for a frame after the pause instant, or arrives late for a frame inside
    // the span, is still silenced when that frame commits.
    public int OpenGate(int laneMask, long fromFrame)
    {
        lock (gate)
        {
            var span = new GateSpan(++nextGateId, laneMask, fromFrame);
            gates.Add(span);
            return span.Id;
        }
    }

    public void CloseGate(int id, long atFrame)
    {
        lock (gate)
        {
            var span = gates.Find(candidate => candidate.Id == id);
            if (span is not null) span.End = Math.Max(span.Start, atFrame);
        }
    }

    private void SilenceGatedSpans(long from, long to)
    {
        foreach (var span in gates)
        {
            var start = Math.Max(span.Start, from);
            var end = Math.Min(span.End ?? long.MaxValue, to);
            if (end <= start) continue;
            for (var lane = 0; lane < lanes.Length; lane++)
            {
                if ((span.LaneMask & (1 << lane)) == 0) continue;
                for (var frame = start; frame < end; frame++) lanes[lane][(int)(frame % capacity)] = 0;
            }
        }
    }

    private static void Sum(Span<float> destination, ReadOnlySpan<float> source)
    {
        for (var index = 0; index < source.Length; index++) destination[index] += source[index];
    }

    private static short ToPcm16(float value)
    {
        if (float.IsNaN(value)) return 0;
        return (short)Math.Clamp(MathF.Round(value * 32768f), short.MinValue, short.MaxValue);
    }

    private sealed class GateSpan(int id, int laneMask, long start)
    {
        public int Id { get; } = id;
        public int LaneMask { get; } = laneMask;
        public long Start { get; } = start;
        public long? End { get; set; }
    }
}
