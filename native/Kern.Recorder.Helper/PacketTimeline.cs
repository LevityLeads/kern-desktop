namespace Kern.Recorder.Helper;

// Device frames establish continuity. QPC places each new run on the shared timeline.
// Keeping this anchor across checkpoints avoids packet jitter and accumulated rounding.
internal sealed class PacketTimeline(int sampleRate)
{
    private AudioPacket? previous;
    private long anchorTicks;
    private long anchorPosition;
    private long expectedPosition;

    public AudioPacket Map(AudioPacket packet, int frames)
    {
        var observedAt = packet.ObservedAtTicks ?? checked(packet.TimelineStartTicks + TimelineClock.DurationForFrames(frames, sampleRate));
        if (checked(packet.TimelineStartTicks + TimelineClock.DurationForFrames(frames, sampleRate)) > observedAt)
            throw new InvalidDataException("Capture packet timestamp is later than its capture callback.");
        var projectedEnd = previous is null || packet.DevicePosition < anchorPosition ? long.MaxValue : checked(anchorTicks +
            TimelineClock.DurationForFrames(packet.DevicePosition - anchorPosition + frames, sampleRate));
        var joins = projectedEnd <= observedAt && packet.PositionTrusted && previous is { PositionTrusted: true } &&
            !packet.Discontinuity && packet.ContinuityId == previous.ContinuityId &&
            packet.Generation == previous.Generation && packet.PersistenceEpoch == previous.PersistenceEpoch &&
            packet.DevicePosition == expectedPosition;
        if (!joins)
        {
            anchorTicks = packet.TimelineStartTicks;
            anchorPosition = packet.DevicePosition;
        }
        var start = joins
            ? checked(anchorTicks + TimelineClock.DurationForFrames(packet.DevicePosition - anchorPosition, sampleRate))
            : packet.TimelineStartTicks;
        // Never publish frames placed after their capture callback. That callback runs
        // under the same fence lock as pause/stop, so future cutoffs cannot precede it.
        if (checked(start + TimelineClock.DurationForFrames(frames, sampleRate)) > observedAt)
            throw new InvalidDataException("Capture packet extends beyond its observed capture time.");
        expectedPosition = checked(packet.DevicePosition + frames);
        previous = packet;
        return packet with
        {
            TimelineStartTicks = start,
            OriginalStartTicks = packet.TimelineStartTicks,
            StartsNewRun = !joins,
        };
    }

    public void Reset() => previous = null;
}
