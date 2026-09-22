using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class StreamAlignerTests
{
    private const int Packet = 160;

    [Fact]
    public void JitteryDeliveryStaysContiguous()
    {
        var aligner = new StreamAligner();
        var random = new Random(7);
        long expected = -1;
        for (var packet = 1; packet <= 1000; packet++)
        {
            var arrival = packet * (long)Packet + random.Next(0, 3200);
            var start = Place(aligner, arrival, null);
            if (expected >= 0) Assert.Equal(expected, start);
            expected = start + Packet;
        }
        Assert.Equal(0, aligner.Gaps);
        Assert.Equal(0, aligner.Resyncs);
    }

    [Fact]
    public void AHoleLongerThanAQuarterSecondIsLeftSilentAndCounted()
    {
        var aligner = new StreamAligner();
        Assert.Equal(0, Place(aligner, Packet, null));
        Assert.Equal(Packet, Place(aligner, 2 * Packet, null));
        // The source goes quiet for a second (an idle loopback endpoint emits nothing).
        var resumed = 2 * Packet + 16_000 + Packet;
        Assert.Equal(resumed - Packet, Place(aligner, resumed, null));
        Assert.Equal(1, aligner.Gaps);
        Assert.Equal(16_000, aligner.GapFramesTotal);
        // A hole of exactly a quarter second is still treated as jitter.
        var edge = resumed + StreamAligner.GapFrames + Packet;
        Assert.Equal(resumed, Place(aligner, edge, null));
        Assert.Equal(1, aligner.Gaps);
    }

    [Fact]
    public void BurstWithTrustedQpcLandsEveryPacketAtItsStamp()
    {
        var aligner = new StreamAligner();
        // Five packets held back by the driver, then delivered together 300 ms late.
        var deliveredAt = 5 * Packet + 4800;
        for (var packet = 0; packet < 5; packet++)
            Assert.Equal(packet * Packet, Place(aligner, deliveredAt, packet * (long)Packet));
        Assert.Equal(0, aligner.Gaps);
    }

    [Fact]
    public void BurstWithoutQpcStaysContiguousAfterItsFirstPacket()
    {
        var aligner = new StreamAligner();
        Place(aligner, Packet, null);
        var deliveredAt = 60 * Packet;
        var first = Place(aligner, deliveredAt, null);
        for (var packet = 1; packet < 8; packet++)
            Assert.Equal(first + packet * Packet, Place(aligner, deliveredAt, null));
        Assert.Equal(1, aligner.Gaps);
        Assert.Equal(0, aligner.Resyncs);
    }

    [Fact]
    public void ASourceRunningFastIsPulledBackAfterTwoSecondsOfDrift()
    {
        var aligner = new StreamAligner();
        // 161 samples per 160-frame tick: the source clock runs 0.6% fast.
        long arrival = 0;
        for (var packet = 0; packet < 40_000 && aligner.Resyncs == 0; packet++)
        {
            arrival += Packet;
            aligner.Accept(aligner.Place(161, arrival, null), 161);
        }
        Assert.Equal(1, aligner.Resyncs);
        Assert.Equal(0, aligner.Gaps);
    }

    [Fact]
    public void ASourceRunningSlowOpensAGapOnceAQuarterSecondBehind()
    {
        var aligner = new StreamAligner();
        long arrival = 0;
        for (var packet = 0; packet < 20_000 && aligner.Gaps == 0; packet++)
        {
            arrival += Packet;
            aligner.Accept(aligner.Place(159, arrival, null), 159);
        }
        Assert.Equal(1, aligner.Gaps);
        Assert.Equal(0, aligner.Resyncs);
    }

    [Theory]
    [InlineData(10_000L)]        // stamped in the future
    [InlineData(-40_000L)]       // older than the 2 s window
    public void GarbageQpcFallsBackToArrivalTime(long qpcOffset)
    {
        var aligner = new StreamAligner();
        const long arrival = 100_000;
        Assert.Equal(arrival - Packet, Place(aligner, arrival, arrival + qpcOffset));
    }

    [Fact]
    public void AcceptFollowsTheMixersShiftedStart()
    {
        var aligner = new StreamAligner();
        var proposed = aligner.Place(Packet, Packet, null);
        aligner.Accept(proposed + 500, Packet);
        Assert.Equal(proposed + 500 + Packet, aligner.Place(Packet, 2 * Packet, null));
    }

    private static long Place(StreamAligner aligner, long arrival, long? qpc)
    {
        var start = aligner.Place(Packet, arrival, qpc);
        aligner.Accept(start, Packet);
        return start;
    }
}
