using System.Diagnostics;
using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class SessionClockTests
{
    [Fact]
    public void MapsTicksToFramesByFloorOnBothSidesOfTheOrigin()
    {
        var fake = new FakeClock();
        var clock = new SessionClock(fake.Timeline, fake.Timeline.NowTicks);
        var frame = Stopwatch.Frequency / CallAudio.SampleRate;

        Assert.Equal(0, clock.FrameAt(frame - 1));
        Assert.Equal(1, clock.FrameAt(frame));
        Assert.Equal(-1, clock.FrameAt(-1));
        fake.Advance(TimeSpan.FromSeconds(3));
        Assert.Equal(48_000, clock.NowFrame);
    }

    [Fact]
    public void QpcStampsLandOnTheSessionTimelineAndNonsenseIsRejected()
    {
        var fake = new FakeClock();
        var clock = new SessionClock(fake.Timeline, fake.Timeline.NowTicks);
        fake.Advance(TimeSpan.FromSeconds(1));

        Assert.Equal(16_000, clock.FrameAtQpc(FakeClock.ToQpc100Nanoseconds(fake.Raw)));
        Assert.Null(clock.FrameAtQpc(0));
        Assert.Null(clock.FrameAtQpc(-5));
        Assert.Null(clock.FrameAtQpc(long.MaxValue));
    }
}
