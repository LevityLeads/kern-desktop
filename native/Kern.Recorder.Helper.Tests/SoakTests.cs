using System.Buffers.Binary;
using System.Diagnostics;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

// The v1 failure, replayed at scale: two sources delivering 10 ms packets with jitter and
// driver bursts for 30 simulated minutes, through the real converter, aligner, mixer and commit
// loop. Every sample must land exactly once, in place, with nothing dropped.
public sealed class SoakTests
{
    private const int Minutes = 30;
    private const int PacketsPerSource = Minutes * 60 * 100;
    private const float MeLevel = 0.25f;
    private const float ThemLevel = -0.375f;

    [Fact]
    public void ThirtyMinutesOfJitteryBurstyCaptureCommitsEverySampleExactlyOnce()
    {
        var clock = new FakeClock();
        var sessionClock = new SessionClock(clock.Timeline, clock.Timeline.NowTicks);
        var mixer = new CallMixer();
        var sink = new CountingSink();
        using var loop = new CommitLoop(mixer, sink);
        var random = new Random(20260922);

        // "Me": a 48 kHz float microphone with trusted QPC stamps, bursts of up to a second
        // (Bluetooth), and the occasional packet flagged TimestampError.
        var me = new SimulatedSource(new SourcePipeline(CallAudio.MeLane, sessionClock, mixer),
            WaveFormat.CreateIeeeFloatWaveFormat(48_000, 2), MeLevel, random, maxJitterMs: 20,
            burstChance: 0.01, maxBurstMs: 1000, hasQpc: true);
        // "Them": 44.1 kHz int16 endpoint loopback with no usable QPC at all, bursts short enough
        // that arrival time alone keeps it contiguous.
        var them = new SimulatedSource(new SourcePipeline(CallAudio.ThemLane, sessionClock, mixer),
            new WaveFormat(44_100, 16, 2), ThemLevel, random, maxJitterMs: 30,
            burstChance: 0.005, maxBurstMs: 200, hasQpc: false);

        var commitEvery = Stopwatch.Frequency / 5;
        var nextCommit = clock.Raw + commitEvery;
        while (me.Pending || them.Pending)
        {
            var next = me.NextDelivery <= them.NextDelivery ? me : them;
            while (nextCommit <= next.NextDelivery)
            {
                clock.Raw = nextCommit;
                loop.Pump(sessionClock.NowFrame);
                nextCommit += commitEvery;
            }
            clock.Raw = next.NextDelivery;
            next.Deliver();
        }
        clock.Advance(TimeSpan.FromSeconds(2));
        var stopFrame = sessionClock.NowFrame;
        loop.Finish(stopFrame);

        var meStats = me.Pipeline.Stats();
        var themStats = them.Pipeline.Stats();
        foreach (var stats in new[] { meStats, themStats })
        {
            Assert.Equal(PacketsPerSource, stats.Packets);
            Assert.Equal(0, stats.DroppedFrames);
            Assert.Equal(0, stats.LateFrames);
            Assert.Equal(0, stats.Gaps);
            Assert.Equal(0, stats.Resyncs);
        }
        Assert.Equal(PacketsPerSource * 480L, meStats.InputFrames);
        Assert.Equal(PacketsPerSource * 441L, themStats.InputFrames);
        // 160 output samples per 10 ms packet, less the resampler's fixed filter delay.
        const long ideal = PacketsPerSource * 160L;
        Assert.InRange(meStats.OutputFrames, ideal - 32, ideal);
        Assert.InRange(themStats.OutputFrames, ideal - 32, ideal);

        Assert.Equal(stopFrame, loop.CommittedFrames);
        Assert.Equal(stopFrame, sink.Frames);
        sink.Me.AssertContiguous(meStats.OutputFrames, MeLevel);
        sink.Them.AssertContiguous(themStats.OutputFrames, ThemLevel);
    }

    private sealed class SimulatedSource
    {
        private readonly byte[] packet;
        private readonly Random random;
        private readonly int maxJitterMs;
        private readonly double burstChance;
        private readonly int maxBurstMs;
        private readonly bool hasQpc;
        private readonly long originRaw;
        private long heldUntil;
        private bool held;
        private long lastDelivery;
        private int index;

        public SimulatedSource(SourcePipeline pipeline, WaveFormat format, float level, Random random,
            int maxJitterMs, double burstChance, int maxBurstMs, bool hasQpc)
        {
            Pipeline = pipeline;
            this.random = random;
            this.maxJitterMs = maxJitterMs;
            this.burstChance = burstChance;
            this.maxBurstMs = maxBurstMs;
            this.hasQpc = hasQpc;
            pipeline.Bind(format);
            packet = Constant(format, format.SampleRate / 100, level);
            originRaw = Stopwatch.Frequency * 1000;
            Schedule();
        }

        public SourcePipeline Pipeline { get; }
        public bool Pending => index < PacketsPerSource;
        public long NextDelivery { get; private set; }

        public void Deliver()
        {
            // TimestampError only outside bursts: a burst without QPC is the other source's case.
            var stamped = hasQpc && (held || random.NextDouble() > 0.05);
            var qpc = stamped ? FakeClock.ToQpc100Nanoseconds(DeviceStart(index)) : (long?)null;
            Pipeline.Accept(packet, silent: false, qpc);
            index++;
            if (Pending) Schedule();
            else NextDelivery = long.MaxValue;
        }

        // A packet is ready when its last frame is captured; the driver then adds jitter, may
        // hold a run of packets back and release them together, and never reorders.
        private void Schedule()
        {
            var ready = DeviceStart(index + 1);
            if (random.NextDouble() < burstChance)
                heldUntil = ready + Milliseconds(random.Next(maxBurstMs / 2, maxBurstMs + 1));
            var delivery = Math.Max(ready + Milliseconds(random.Next(0, maxJitterMs + 1)), heldUntil);
            NextDelivery = lastDelivery = Math.Max(delivery, lastDelivery);
            held = NextDelivery > ready + Milliseconds(maxJitterMs);
        }

        private long DeviceStart(int packetIndex) => originRaw + packetIndex * Stopwatch.Frequency / 100;

        private static long Milliseconds(int ms) => ms * Stopwatch.Frequency / 1000;

        private static byte[] Constant(WaveFormat format, int frames, float level)
        {
            var bytes = new byte[frames * format.BlockAlign];
            var width = format.BitsPerSample / 8;
            for (var offset = 0; offset < bytes.Length; offset += width)
            {
                if (format.Encoding == WaveFormatEncoding.IeeeFloat) BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(offset), level);
                else BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(offset), (short)(level * 32768));
            }
            return bytes;
        }
    }

    // Streams the committed audio without keeping 115 MB of it in memory.
    private sealed class CountingSink : ICallSink
    {
        public long Frames { get; private set; }
        public LaneCheck Me { get; } = new();
        public LaneCheck Them { get; } = new();

        public void Append(ReadOnlySpan<byte> frames)
        {
            for (var offset = 0; offset < frames.Length; offset += CallAudio.BytesPerFrame, Frames++)
            {
                Me.Observe(Frames, BinaryPrimitives.ReadInt16LittleEndian(frames[offset..]));
                Them.Observe(Frames, BinaryPrimitives.ReadInt16LittleEndian(frames[(offset + 2)..]));
            }
        }

        public void Flush(bool toDisk) { }
        public void CloseAudio() { }
        public void WriteSession(SessionDocument document) { }
        public void Dispose() { }
    }

    private sealed class LaneCheck
    {
        private long first = -1;
        private long last = -1;
        private long audible;
        private long peak;

        public void Observe(long frame, short value)
        {
            if (value == 0) return;
            if (first < 0) first = frame;
            last = frame;
            audible++;
            peak = Math.Max(peak, Math.Abs((long)value));
        }

        // Every sample the source produced is in the file once: no holes between the first and
        // last audible frame (beyond the resampler's warm-up ramp), and nothing summed twice.
        public void AssertContiguous(long outputFrames, float level)
        {
            var expected = Math.Abs(level) * 32768;
            // The sinc filter rings on the opening step; a doubled overlap would read 2x.
            Assert.InRange(peak, expected * 0.98, expected * 1.3);
            Assert.InRange(last - first + 1, outputFrames - 16, outputFrames);
            Assert.InRange(audible, last - first + 1 - 16, last - first + 1);
        }
    }
}
