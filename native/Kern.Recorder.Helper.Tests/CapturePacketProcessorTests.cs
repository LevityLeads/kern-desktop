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
            DevicePosition: 0,
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
