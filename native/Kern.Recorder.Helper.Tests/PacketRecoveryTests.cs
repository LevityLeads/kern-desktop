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
    public void BadTimestampKeepsPriorAudioAndFollowingPacketsWithoutCompressingGap()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(Packet(480, T(4800))));
        Assert.True(processor.TryEnqueue(Packet(960)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(960, segments.Sum(s => s.SampleCount));
        Assert.Equal(2, segments.Count);
        Assert.Equal(T(960), segments[1].TimelineStartTicks);
        Assert.Empty(Directory.GetFiles(root, "*.partial", SearchOption.AllDirectories));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void UntrustedOrOverflowingTimestampDoesNotLoseFollowingAudio(bool overflow)
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(Packet(480, overflow ? long.MaxValue : T(480))
            with { PositionTrusted = overflow }));
        Assert.True(processor.TryEnqueue(Packet(960)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(480, processor.OmittedFrames);
        Assert.Equal(960, segments.Sum(s => s.SampleCount));
        Assert.Equal(0, processor.PendingFrames);
    }

    [Fact]
    public void BackwardDiscontinuityCannotPublishOverlappingAudio()
    {
        var segments = new List<SegmentManifest>();
        var failures = new List<Exception>();
        using var processor = Processor(segments, failures);
        Assert.True(processor.TryEnqueue(Packet(0)));
        Assert.True(processor.TryEnqueue(Packet(480, T(240)) with { Discontinuity = true }));
        Assert.True(processor.TryEnqueue(Packet(960)));
        processor.Flush(T(1440), 1);
        Assert.Empty(failures);
        Assert.Equal(960, segments.Sum(s => s.SampleCount));
        Assert.True(segments[1].TimelineStartTicks >= segments[0].TimelineEndTicks);
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
                var start = kind == "render" && index == 1 ? T(4800) : T(index * 480);
                Assert.True(processor.TryEnqueue(Packet(index * 480, start) with { Data = bytes }));
            }
            processor.Flush(T(1440), 1);
        }
        Assert.Empty(failures);
        fixture.Render();
        // Incoming plus mic before/after interruption; microphone alone inside the gap.
        Assert.InRange(fixture.Sample(80), 8900, 9100);
        Assert.InRange(fixture.Sample(240), 2900, 3100);
        Assert.InRange(fixture.Sample(400), 8900, 9100);
        Assert.Equal(960, fixture.Session.Segments.Where(s => s.TrackId == "render").Sum(s => s.SampleCount));
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
        Assert.Equal(240, Assert.Single(segments).SampleCount);
        Assert.All(segments, s => Assert.True(s.TimelineStartTicks >= 1 && s.TimelineEndTicks <= T(720)));
    }

    private CapturePacketProcessor Processor(List<SegmentManifest> segments, List<Exception> failures) =>
        new(root, "render", new WaveFormat(Rate, 16, 2), 5000, 32,
            new TimelineClock(), segments.Add, (error, _) => failures.Add(error));

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}
