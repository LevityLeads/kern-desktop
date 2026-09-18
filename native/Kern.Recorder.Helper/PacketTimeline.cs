namespace Kern.Recorder.Helper;

// Device frames establish continuity. QPC anchors each new run. Bad clock data is
// a packet omission, never a disk failure. Resetting trust must retain the last
// accepted end, otherwise a backward timestamp can replay audio over an old run.
internal sealed class PacketTimeline(int sampleRate)
{
    private AudioPacket? previous;
    private long anchorTicks;
    private long anchorPosition;
    private long expectedPosition;
    private long lastEnd = long.MinValue;

    public AudioPacket? Map(AudioPacket packet, int frames)
    {
        try { return MapChecked(packet, frames); }
        catch (OverflowException) { return Omit(); }
        catch (ArgumentOutOfRangeException) { return Omit(); }
    }

    private AudioPacket? MapChecked(AudioPacket packet, int frames)
    {
        if (!packet.PositionTrusted || frames <= 0 || packet.DevicePosition < 0) return Omit();
        var duration = TimelineClock.DurationForFrames(frames, sampleRate);
        var rawEnd = checked(packet.TimelineStartTicks + duration);
        var observedAt = packet.ObservedAtTicks ?? rawEnd;
        // Permit at most one sample interval of endpoint/QPC quantisation. The
        // chosen mapping still ends at or before observation, with no overlap.
        var rounding = Math.Max(1, TimelineClock.DurationForFrames(1, sampleRate));
        if (rawEnd > observedAt && checked(rawEnd - observedAt) > rounding) return Omit();
        var projectedEnd = previous is null || packet.DevicePosition < anchorPosition ? long.MaxValue : checked(anchorTicks +
            TimelineClock.DurationForFrames(checked(packet.DevicePosition - anchorPosition + frames), sampleRate));
        var joins = projectedEnd <= observedAt && previous is not null &&
            !packet.Discontinuity && packet.ContinuityId == previous.ContinuityId &&
            packet.Generation == previous.Generation && packet.PersistenceEpoch == previous.PersistenceEpoch &&
            packet.DevicePosition == expectedPosition;
        var start = joins
            ? checked(anchorTicks + TimelineClock.DurationForFrames(packet.DevicePosition - anchorPosition, sampleRate))
            : Math.Min(packet.TimelineStartTicks, checked(observedAt - duration));
        if (start < lastEnd || start < (packet.MinimumStartTicks ?? long.MinValue)) return Omit();
        if (!joins)
        {
            anchorTicks = start;
            anchorPosition = packet.DevicePosition;
        }
        lastEnd = checked(start + duration);
        expectedPosition = checked(packet.DevicePosition + frames);
        previous = packet;
        return packet with
        {
            TimelineStartTicks = start,
            OriginalStartTicks = packet.TimelineStartTicks,
            StartsNewRun = !joins,
        };
    }

    private AudioPacket? Omit() { previous = null; return null; }
    public void Reset() => previous = null;
}
