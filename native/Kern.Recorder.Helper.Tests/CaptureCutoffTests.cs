namespace Kern.Recorder.Helper.Tests;

public sealed class CaptureCutoffTests
{
    private const int SampleRate = 48_000;
    private static readonly long FrameTicks = TimelineClock.Frequency / SampleRate;

    [Theory]
    [InlineData(0, 0, 480, 0)]
    [InlineData(0, 1, 480, 1)]
    [InlineData(0, 480, 480, 480)]
    [InlineData(10_000, 10_000, 480, 0)]
    [InlineData(10_000, 9_999, 480, 0)]
    public void PauseFenceKeepsOnlyFramesStrictlyBeforeCutoff(
        long startFrame,
        long cutoffFrame,
        int totalFrames,
        int expectedFrames)
    {
        Assert.Equal(
            expectedFrames,
            CaptureTrack.FramesStrictlyBefore(
                startFrame * FrameTicks,
                cutoffFrame * FrameTicks,
                totalFrames,
                SampleRate));
    }

    // Rees's FIFINE (2026-09-22): position jumped 8,895,840 frames forward on a discontinuity
    // while callbacks kept arriving every 10 ms and every frame was persisted. That is a
    // counter reset, not 185 s of lost audio, and must not be reported as loss.
    [Theory]
    [InlineData(8_895_840, 10, 480, 0)]
    [InlineData(8_895_840, 185_340, 480, 8_895_840)]
    [InlineData(8_895_840, 30, 480, 960)]
    [InlineData(100, 30, 480, 100)]
    [InlineData(0, 30, 480, 0)]
    [InlineData(100, 0, 480, 0)]
    public void DiscontinuityLossIsClaimedOnlyWhereTheClockCorroboratesIt(
        long positionGap, long elapsedMs, int packetFrames, long expectedLost)
    {
        Assert.Equal(
            expectedLost,
            CaptureTrack.CorroboratedLoss(positionGap, elapsedMs * TimelineClock.Frequency / 1000, packetFrames, SampleRate));
    }

    [Fact]
    public void PauseFenceKeepsStraddlingFrameWhoseTimestampPrecedesCutoff()
    {
        var cutoff = FrameTicks + FrameTicks / 2;
        Assert.Equal(
            2,
            CaptureTrack.FramesStrictlyBefore(0, cutoff, totalFrames: 480, SampleRate));
    }

    [Fact]
    public void LongTimelineConversionsDoNotOverflow()
    {
        var twoHours = checked(TimelineClock.Frequency * 2 * 60 * 60);

        Assert.Equal(2 * 60 * 60 * 1000L, TimelineClock.ToMilliseconds(twoHours));
        Assert.Equal(2 * 60 * 60 * SampleRate, TimelineClock.FramesForDuration(twoHours, SampleRate));
        Assert.Equal(twoHours, TimelineClock.DurationForFrames(2 * 60 * 60 * SampleRate, SampleRate));
    }

    [Fact]
    public void LargeQpcAnchorDoesNotOverflow()
    {
        const long qpc100Nanoseconds = 100_000_000_000_000;
        var expected = qpc100Nanoseconds / 10_000_000L * TimelineClock.Frequency +
            qpc100Nanoseconds % 10_000_000L * TimelineClock.Frequency / 10_000_000L;

        Assert.Equal(expected, TimelineClock.Scale(qpc100Nanoseconds, TimelineClock.Frequency, 10_000_000L));
    }
}
