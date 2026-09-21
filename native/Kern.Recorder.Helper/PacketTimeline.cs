namespace Kern.Recorder.Helper;

// Audio bytes are never discarded because of clock data. The device frame
// position establishes continuity: contiguous frames always extend the current
// run, whatever their timestamps say (Bluetooth endpoints flag TimestampError
// for long stretches, and bursty delivery is normal). A new run is anchored by
// its QPC timestamp only when that is trusted and plausible against the callback
// that observed it; otherwise by arrival time. Nothing is placed before the
// previously published end, so a backward clock can delay audio, never overlap it.
internal sealed class PacketTimeline(int sampleRate)
{
    // A trusted QPC anchor may precede its callback by at most this much (device
    // and driver latency); anything earlier or in the future is treated as noise.
    internal static readonly long MaxAnchorLagTicks = 2 * TimelineClock.Frequency;
    private AudioPacket? previous;
    private long anchorTicks;
    private long anchorPosition;
    private long expectedPosition = long.MinValue;
    private long lastEnd = long.MinValue;

    public AudioPacket? Map(AudioPacket packet, int frames)
    {
        if (frames <= 0) return null;
        try { return MapChecked(packet, frames); }
        catch (OverflowException)
        {
            // Garbage clock data: place by arrival, or directly after the last run.
            return MapChecked(packet with
            {
                TimestampTrusted = false,
                ObservedAtTicks = packet.ObservedAtTicks ?? Math.Max(0, lastEnd),
            }, frames);
        }
    }

    private AudioPacket MapChecked(AudioPacket packet, int frames)
    {
        var duration = TimelineClock.DurationForFrames(frames, sampleRate);
        var observedAt = packet.ObservedAtTicks ?? checked(packet.TimelineStartTicks + duration);
        var joins = packet.PositionTrusted && previous is not null &&
            !packet.Discontinuity && packet.ContinuityId == previous.ContinuityId &&
            packet.Generation == previous.Generation && packet.PersistenceEpoch == previous.PersistenceEpoch &&
            packet.DevicePosition == expectedPosition;
        var arrival = checked(observedAt - duration);
        // The raw clock is only believed when it sits within device latency of the
        // callback. A garbage value must neither anchor a run nor decide, at a
        // pause or stop fence, that frames were captured after the cutoff.
        var plausibleClock = packet.TimestampTrusted && packet.TimelineStartTicks <= arrival &&
            checked(arrival - packet.TimelineStartTicks) <= MaxAnchorLagTicks;
        long start;
        if (joins)
        {
            start = checked(anchorTicks + TimelineClock.DurationForFrames(checked(packet.DevicePosition - anchorPosition), sampleRate));
        }
        else
        {
            start = plausibleClock ? packet.TimelineStartTicks : arrival;
            start = Math.Max(start, Math.Max(lastEnd, Math.Max(0, packet.MinimumStartTicks ?? 0)));
            anchorTicks = start;
            anchorPosition = packet.DevicePosition;
        }
        lastEnd = checked(start + duration);
        expectedPosition = packet.PositionTrusted ? checked(packet.DevicePosition + frames) : long.MinValue;
        previous = packet;
        return packet with
        {
            TimelineStartTicks = start,
            OriginalStartTicks = plausibleClock ? packet.TimelineStartTicks : start,
            StartsNewRun = !joins,
        };
    }

    public void Reset() => previous = null;
}
