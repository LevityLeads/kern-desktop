using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class PacketRecoveryTests : IDisposable
{
    private const int Rate = 48000;
    private readonly string root = Path.Combine(Path.GetTempPath(), "kern-packet-recovery-" + Guid.NewGuid().ToString("N"));
    private static long T(long frames) => TimelineClock.DurationForFrames(frames, Rate);
    private static AudioPacket Packet(long position, long? start = null, long? observed = null) =>
        new(new byte[480 * 4], position, 1, start ?? T(position), 1, 1,
            ObservedAtTicks: observed ?? T(position + 480));

    [Fact]
    public void OneTickOfQpcRoundingDoesNotKillContinuousCapture()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(Packet(480, T(480) + 1)));
        Assert.True(processor.TryEnqueue(Packet(960)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(1440, segments.Sum(s => s.SampleCount));
        Assert.Single(segments);
    }

    [Fact]
    public void BadTimestampOnContiguousFramesJoinsTheRunWithoutLoss()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(Packet(480, T(4800))));
        Assert.True(processor.TryEnqueue(Packet(960)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(0, processor.OmittedFrames);
        var segment = Assert.Single(segments);
        Assert.Equal(1440, segment.SampleCount);
        Assert.Equal(0, segment.TimelineStartTicks);
        Assert.Empty(Directory.GetFiles(root, "*.partial", SearchOption.AllDirectories));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UntrustedOrOverflowingTimestampDoesNotLoseAudio(bool overflow)
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(Packet(480, overflow ? long.MaxValue : T(480))
            with { TimestampTrusted = false }));
        Assert.True(processor.TryEnqueue(Packet(960)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(0, processor.OmittedFrames);
        Assert.Equal(1440, Assert.Single(segments).SampleCount);
        Assert.Equal(0, processor.PendingFrames);
    }

    [Fact]
    public void TimestampErrorFlaggedStreamIsRecordedAsOneRun()
    {
        // Bluetooth loopback: every packet carries TimestampError, frames stay contiguous.
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures, queueCapacity: 256);
        for (var i = 0; i < 100; i++)
            Assert.True(processor.TryEnqueue(Packet(i * 480L, 0) with { TimestampTrusted = false, QpcPosition = 0 }));
        processor.Flush(T(100 * 480), 1);
        Assert.Empty(failures);
        Assert.Equal(0, processor.OmittedFrames);
        var segment = Assert.Single(segments);
        Assert.Equal(48000, segment.SampleCount);
        Assert.Equal(0, segment.TimelineStartTicks);
    }

    [Fact]
    public void BurstDeliveryKeepsOneRun()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        for (var i = 0; i < 3; i++)
            Assert.True(processor.TryEnqueue(Packet(i * 480L, observed: T(1440))));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(0, processor.OmittedFrames);
        var segment = Assert.Single(segments);
        Assert.Equal(1440, segment.SampleCount);
        Assert.Equal(0, segment.TimelineStartTicks);
    }

    [Fact]
    public void GarbageClockWithoutObservationIsPlacedAfterTheLastRun()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(new AudioPacket(new byte[480 * 4], 4800, 1, long.MaxValue, 1, 1)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(0, processor.OmittedFrames);
        Assert.Equal(2, segments.Count);
        Assert.Equal(T(480), segments[1].TimelineStartTicks);
    }

    [Fact]
    public void BackwardDiscontinuityIsDelayedNotDropped()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(Packet(480, T(240)) with { Discontinuity = true }));
        Assert.True(processor.TryEnqueue(Packet(960)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(0, processor.OmittedFrames);
        Assert.Equal(1440, segments.Sum(s => s.SampleCount));
        Assert.Equal(2, segments.Count);
        Assert.Equal(segments[0].TimelineEndTicks, segments[1].TimelineStartTicks);
    }

    [Fact]
    public void ActualCaptureSegmentsRenderIncomingAndMicrophoneAfterTimingInterruption()
    {
        using var fixture = new RenderFixture(30, frequency: TimelineClock.Frequency);
        var failures = new List<Exception>();
        foreach (var kind in new[] { "render", "microphone" })
        {
            var wave = new WaveFormat(48000, 16, 1);
            fixture.Session.Tracks.Add(new TrackManifest { TrackId = kind, EndpointId = kind, Name = kind,
                Kind = kind, DefaultRoles = [], Format = new(48000, 1, 16, 2, 96000, "pcm", null, null, null) });
            using var processor = new CapturePacketProcessor(fixture.Root, kind, wave, 5000, 32,
                new TimelineClock(), fixture.Session.Segments.Add, (error, _) => failures.Add(error));
            for (var index = 0; index < 3; index++)
            {
                var bytes = new byte[960];
                var amplitude = (short)(kind == "render" ? 6000 : 3000);
                for (var frame = 0; frame < 480; frame++)
                    System.Buffers.Binary.BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(frame * 2, 2), amplitude);
                // Incoming audio really stops for 90 ms: the endpoint's frame counter jumps.
                var position = kind == "render" && index > 0 ? 4320L + index * 480 : index * 480L;
                Assert.True(processor.TryEnqueue(Packet(position) with { Data = bytes }));
            }
            processor.Flush(T(5760), 1);
        }
        Assert.Empty(failures);
        fixture.Render();
        // Both before the interruption, microphone alone inside it, incoming alone after it. Each side sits on
        // its own output channel, so the split is visible per channel rather than as a summed level.
        const int mic = RenderConstants.MicrophoneLane, playback = RenderConstants.PlaybackLane;
        Assert.InRange(fixture.Sample(80, mic), 2900, 3100);
        Assert.InRange(fixture.Sample(80, playback), 5900, 6100);
        Assert.InRange(fixture.Sample(240, mic), 2900, 3100);
        Assert.Equal(0, fixture.Sample(240, playback));
        Assert.InRange(fixture.Sample(400, mic), 2900, 3100);
        Assert.Equal(0, fixture.Sample(400, playback));
        Assert.Equal(0, fixture.Sample(1700, mic));
        Assert.InRange(fixture.Sample(1700, playback), 5900, 6100);
        Assert.Equal(1440, fixture.Session.Segments.Where(s => s.TrackId == "render").Sum(s => s.SampleCount));
    }

    [Fact]
    public void NewRunRoundingCannotCrossResumeFence()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0, 1, T(480)) with { MinimumStartTicks = 1 }));
        Assert.True(processor.TryEnqueue(Packet(480)));
        processor.Flush(T(720), 1);
        Assert.Empty(failures);
        Assert.Equal(720, Assert.Single(segments).SampleCount);
        Assert.All(segments, s => Assert.True(s.TimelineStartTicks >= 1 && s.TimelineEndTicks <= T(720)));
    }

    private CapturePacketProcessor Processor(List<SegmentManifest> segments, List<Exception> failures, int queueCapacity = 32) =>
        new(root, "render", new WaveFormat(Rate, 16, 2), 5000, queueCapacity,
            new TimelineClock(), segments.Add, (error, _) => failures.Add(error));

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}
