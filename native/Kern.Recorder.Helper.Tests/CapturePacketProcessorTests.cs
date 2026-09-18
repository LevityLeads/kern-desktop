using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class CapturePacketProcessorTests : IDisposable
{
    private const int SampleRate = 48_000;
    private const int BlockAlign = 4;
    private readonly string root = Path.Combine(Path.GetTempPath(), $"kern-packet-tests-{Guid.NewGuid():N}");

    [Fact]
    public void PauseFlushPersistsQueuedFramesBeforeCutoffOnly()
    {
        var segments = new List<SegmentManifest>();
        using var processor = CreateProcessor(segments);
        var packet = Packet(frameCount: 480, timelineStartTicks: 0, generation: 1, persistenceEpoch: 1);
        Assert.True(processor.TryEnqueue(packet));

        var cutoff = TimelineClock.DurationForFrames(240, SampleRate);
        processor.Flush(cutoff, persistenceEpoch: 1);

        var segment = Assert.Single(segments);
        Assert.Equal(240, segment.SampleCount);
        Assert.Equal(cutoff, segment.TimelineEndTicks);
        Assert.Equal(0, segment.FirstDevicePosition);
        Assert.Equal(239, segment.LastDevicePosition);
        Assert.Equal(1, segment.Generation);
    }

    [Fact]
    public void NewPersistenceEpochCreatesANewSegment()
    {
        var segments = new List<SegmentManifest>();
        using var processor = CreateProcessor(segments);
        var firstCutoff = TimelineClock.DurationForFrames(480, SampleRate);
        Assert.True(processor.TryEnqueue(Packet(480, 0, generation: 1, persistenceEpoch: 1)));
        processor.Flush(firstCutoff, persistenceEpoch: 1);

        var secondStart = firstCutoff + TimelineClock.DurationForFrames(240, SampleRate);
        Assert.True(processor.TryEnqueue(Packet(480, secondStart, generation: 2, persistenceEpoch: 2)));
        processor.Flush(
            secondStart + TimelineClock.DurationForFrames(480, SampleRate),
            persistenceEpoch: 2);

        Assert.Collection(
            segments,
            first =>
            {
                Assert.Equal(1, first.Generation);
                Assert.Equal(480, first.SampleCount);
            },
            second =>
            {
                Assert.Equal(2, second.Generation);
                Assert.Equal(480, second.SampleCount);
                Assert.Equal(secondStart, second.TimelineStartTicks);
            });
    }

    [Fact]
    public void QueueOverflowRejectsPacketWithoutCountingItAsPending()
    {
        var blocker = new BlockingSegmentWriter();
        using var processor = new CapturePacketProcessor(
            root,
            "render-test",
            new WaveFormat(SampleRate, 16, 2),
            segmentDurationMs: 5000,
            queueCapacity: 1,
            new TimelineClock(),
            _ => { },
            (_, _) => { },
            _ => blocker);
        var framesAccepted = 0L;
        var frameOffset = 0L;
        while (!blocker.WriteStarted.IsSet)
        {
            if (processor.TryEnqueue(Packet(480, FrameTicks(frameOffset), generation: 1, persistenceEpoch: 1)))
            {
                framesAccepted += 480;
                frameOffset += 480;
            }
            else Thread.Yield();
        }
        var acceptedAfterBlock = processor.TryEnqueue(
            Packet(480, FrameTicks(frameOffset), generation: 1, persistenceEpoch: 1));
        if (acceptedAfterBlock)
        {
            framesAccepted += 480;
            frameOffset += 480;
        }

        Assert.False(processor.TryEnqueue(Packet(480, FrameTicks(frameOffset), generation: 1, persistenceEpoch: 1)));
        Assert.Equal(framesAccepted, processor.PendingFrames);

        blocker.ReleaseWrite.Set();
        processor.Flush(FrameTicks(frameOffset), persistenceEpoch: 1);
    }

    [Fact]
    public void WriterFailureIsReportedAndFlushReturns()
    {
        Exception? reported = null;
        long lostFrames = 0;
        using var processor = new CapturePacketProcessor(
            root,
            "render-test",
            new WaveFormat(SampleRate, 16, 2),
            segmentDurationMs: 5000,
            queueCapacity: 32,
            new TimelineClock(),
            _ => { },
            (error, lost) =>
            {
                reported = error;
                lostFrames = lost;
            },
            _ => new ThrowingSegmentWriter());
        Assert.True(processor.TryEnqueue(Packet(480, 0, generation: 1, persistenceEpoch: 1)));
        Assert.True(processor.TryEnqueue(Packet(480, FrameTicks(480), generation: 1, persistenceEpoch: 1)));

        processor.Flush(FrameTicks(960), persistenceEpoch: 1);

        Assert.IsType<IOException>(reported);
        Assert.Equal(960, lostFrames);
    }

    [Fact]
    public void UnrelatedSharedGenerationDoesNotDiscardCurrentTrackQueue()
    {
        var segments = new List<SegmentManifest>();
        using var processor = CreateProcessor(segments);
        Assert.True(processor.TryEnqueue(Packet(480, 0, generation: 1, persistenceEpoch: 1)));
        Assert.True(processor.TryEnqueue(Packet(
            480,
            TimelineClock.DurationForFrames(480, SampleRate),
            generation: 1,
            persistenceEpoch: 1)));

        processor.Flush(TimelineClock.DurationForFrames(960, SampleRate), persistenceEpoch: 1);

        var segment = Assert.Single(segments);
        Assert.Equal(960, segment.SampleCount);
        Assert.Equal(1, segment.Generation);
    }

    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    public void ContinuousDeviceFramesIgnorePacketTimestampJitter(int packets)
    {
        var segments = new List<SegmentManifest>();
        using var processor = new CapturePacketProcessor(root, "render-test", new WaveFormat(SampleRate, 16, 2),
            5000, packets + 1, new TimelineClock(), segments.Add, (error, _) => throw error);
        for (var i = 0; i < packets; i++)
        {
            var jitter = i % 2 == 0 ? 0 : TimelineClock.Frequency / 10_000;
            Assert.True(processor.TryEnqueue(Packet(480, FrameTicks(i * 480L) + jitter, 1, 1)
                with { DevicePosition = i * 480L }));
        }
        processor.Flush(FrameTicks(packets * 480L + 480), 1);
        Assert.Equal((packets + 499) / 500, segments.Count);
        Assert.Equal(packets * 480L, segments.Sum(s => s.SampleCount));
        Assert.Equal(FrameTicks(packets * 480L), segments[^1].TimelineEndTicks);
    }

    [Theory]
    [InlineData(960, true, false)]
    [InlineData(0, true, false)]
    [InlineData(480, false, false)]
    [InlineData(480, true, true)]
    public void RealPositionAndTrustBoundariesRemainSeparate(long nextPosition, bool trusted, bool discontinuity)
    {
        var segments = new List<SegmentManifest>();
        using var processor = CreateProcessor(segments);
        Assert.True(processor.TryEnqueue(Packet(480, 0, 1, 1)));
        Assert.True(processor.TryEnqueue(Packet(480, FrameTicks(960), 1, 1)
            with { DevicePosition = nextPosition, PositionTrusted = trusted, Discontinuity = discontinuity }));
        processor.Flush(FrameTicks(1440), 1);
        Assert.Equal(trusted ? 2 : 1, segments.Count);
        if (trusted) Assert.Equal(FrameTicks(960), segments[1].TimelineStartTicks);
        Assert.Equal(trusted ? 960 : 480, segments.Sum(s => s.SampleCount));
        Assert.Equal(trusted ? 0 : 480, processor.OmittedFrames);
    }

    [Fact]
    public void FutureRawTimestampCannotBeHiddenByContinuousDeviceFrames()
    {
        var segments = new List<SegmentManifest>();
        Exception? failure = null;
        using var processor = new CapturePacketProcessor(root, "render-test", new WaveFormat(SampleRate, 16, 2),
            5000, 32, new TimelineClock(), segments.Add, (error, _) => failure = error);
        Assert.True(processor.TryEnqueue(Packet(480, 0, 1, 1) with { ObservedAtTicks = FrameTicks(480) }));
        Assert.True(processor.TryEnqueue(Packet(480, FrameTicks(4800), 1, 1)
            with { DevicePosition = 480, ObservedAtTicks = FrameTicks(960) }));
        Assert.True(processor.TryEnqueue(Packet(480, FrameTicks(960), 1, 1)
            with { DevicePosition = 960, ObservedAtTicks = FrameTicks(1440) }));
        processor.Flush(FrameTicks(1440), 1);
        Assert.Null(failure);
        Assert.Equal(480, processor.OmittedFrames);
        Assert.Equal(960, segments.Sum(s => s.SampleCount));
        Assert.Equal(FrameTicks(960), segments[1].TimelineStartTicks);
        Assert.DoesNotContain(segments, segment => segment.SampleCount > 480);
    }

    [Fact]
    public void MappingCannotPublishFramesBeyondCallbackAndFutureStop()
    {
        var segments = new List<SegmentManifest>();
        using var processor = CreateProcessor(segments);
        for (var i = 0; i < 23; i++)
        {
            var start = TimelineClock.Frequency * i * 9 / 1000;
            Assert.True(processor.TryEnqueue(Packet(480, start, 1, 1) with
                { DevicePosition = i * 480, ObservedAtTicks = start + FrameTicks(480) }));
        }
        var cutoff = TimelineClock.Frequency * 207 / 1000;
        processor.Flush(cutoff, 1);
        Assert.All(segments, segment => Assert.True(segment.TimelineStartTicks + FrameTicks(segment.SampleCount) <= cutoff));
    }

    [Fact]
    public void JitteredFenceUsesBothRawAndMappedCutoff()
    {
        var segments = new List<SegmentManifest>();
        using var processor = CreateProcessor(segments);
        Assert.True(processor.TryEnqueue(Packet(480, 0, 1, 1)));
        Assert.True(processor.TryEnqueue(Packet(480, FrameTicks(504), 1, 1) with { DevicePosition = 480 }));
        processor.Flush(FrameTicks(720), 1);
        var segment = Assert.Single(segments);
        Assert.Equal(696, segment.SampleCount);
        using var reader = new WaveFileReader(Path.Combine(root, segment.RelativePath));
        Assert.Equal(696 * BlockAlign, reader.Length);
    }

    private CapturePacketProcessor CreateProcessor(List<SegmentManifest> segments)
    {
        Directory.CreateDirectory(root);
        return new CapturePacketProcessor(
            root,
            "render-test",
            new WaveFormat(SampleRate, 16, 2),
            segmentDurationMs: 5000,
            queueCapacity: 32,
            new TimelineClock(),
            segments.Add,
            (error, _) => throw error);
    }

    private static long FrameTicks(long frames) =>
        TimelineClock.DurationForFrames(frames, SampleRate);

    private static AudioPacket Packet(
        int frameCount,
        long timelineStartTicks,
        long generation,
        long persistenceEpoch) =>
        new(
            new byte[frameCount * BlockAlign],
            DevicePosition: TimelineClock.FramesForDuration(timelineStartTicks, SampleRate),
            QpcPosition: 10_000,
            timelineStartTicks,
            generation,
            persistenceEpoch);

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }

    private sealed class BlockingSegmentWriter : ISegmentWriter
    {
        public ManualResetEventSlim WriteStarted { get; } = new(false);
        public ManualResetEventSlim ReleaseWrite { get; } = new(false);
        public long TimelineStartTicks => 0;
        public string? MetadataPath => null;
        public long TimelineEndTicks { get; private set; }
        public long SampleCount { get; private set; }

        public void Write(ReadOnlySpan<byte> buffer, long devicePosition, long qpcPosition, long packetStartTicks)
        {
            WriteStarted.Set();
            Assert.True(ReleaseWrite.Wait(TimeSpan.FromSeconds(2)));
            var frames = buffer.Length / BlockAlign;
            SampleCount += frames;
            TimelineEndTicks = packetStartTicks + TimelineClock.DurationForFrames(frames, SampleRate);
        }

        public SegmentManifest Finalise(long timelineEndTicks) => new()
        {
            SegmentId = "blocked",
            TrackId = "render-test",
            Sequence = 0,
            RelativePath = "segments/render-test/blocked.wav",
            Status = "finalised",
            Generation = 1,
            TimelineStartTicks = 0,
            TimelineEndTicks = timelineEndTicks,
            SampleCount = SampleCount,
            ByteLength = SampleCount * BlockAlign,
            Sha256 = new string('0', 64),
            FirstDevicePosition = 0,
            FirstQpcPosition = 0,
            LastDevicePosition = SampleCount - 1,
            LastQpcPosition = 0,
            PublishedAtUtc = DateTimeOffset.UtcNow.ToString("O"),
        };

        public void Dispose()
        {
            ReleaseWrite.Set();
            WriteStarted.Dispose();
            ReleaseWrite.Dispose();
        }
    }

    private sealed class ThrowingSegmentWriter : ISegmentWriter
    {
        public long TimelineStartTicks => 0;
        public string? MetadataPath => null;
        public long TimelineEndTicks => 0;
        public long SampleCount => 0;

        public void Write(ReadOnlySpan<byte> buffer, long devicePosition, long qpcPosition, long packetStartTicks) =>
            throw new IOException("Injected write failure.");

        public SegmentManifest Finalise(long timelineEndTicks) =>
            throw new InvalidOperationException("A failed writer cannot be finalised.");

        public void Dispose()
        {
        }
    }
}
