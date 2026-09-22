using System.Buffers.Binary;
using System.Runtime.InteropServices;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Kern.Recorder.Helper;

internal static class RenderMixer
{
    // A disk-backed accumulator and one decoder keep audio memory block-bounded.
    // The accumulator holds interleaved float frames, one lane per output channel: microphone tracks
    // sum into lane 0, playback endpoints into lane 1, so the two sides of the call never mix.
    // Samples [0, plan.SampleCount) never depend on source audio past that point: runs are read in
    // order from their start and cut at the plan end, so a live render and the final render agree.
    public static (double Peak, double Gain) Mix(RenderPaths paths, RenderPlan plan, string scratch, string output,
        RenderPeakPolicy peakPolicy = RenderPeakPolicy.GlobalGain)
    {
        const int lanes = RenderConstants.Channels;
        using var mixed = new FileStream(paths.Resolve(scratch), FileMode.CreateNew,
            FileAccess.ReadWrite, FileShare.None, 64 * 1024);
        mixed.SetLength(checked(plan.SampleCount * lanes * sizeof(float)));
        var samples = new float[RenderConstants.Block];
        var frames = new float[RenderConstants.Block * lanes];
        foreach (var run in RenderRuns.Group(plan.Inputs))
        {
            if (run.StartSample >= plan.SampleCount) continue;
            var lane = run.Inputs[0].Lane;
            var length = Math.Min(run.SampleCount, plan.SampleCount - run.StartSample);
            using var source = new RenderRunProvider(paths, run);
            ISampleProvider provider = source;
            if (provider.WaveFormat.SampleRate != RenderConstants.Rate)
                provider = new WdlResamplingSampleProvider(provider, RenderConstants.Rate);
            long position = 0;
            while (position < length)
            {
                var wanted = (int)Math.Min(samples.Length, length - position);
                var count = provider.Read(samples.AsSpan(0, wanted));
                if (count == 0) throw new InvalidDataException("Decoder ended before the declared source sample count.");
                var target = checked((run.StartSample + position) * lanes * sizeof(float));
                var block = frames.AsSpan(0, count * lanes);
                mixed.Position = target;
                mixed.ReadExactly(MemoryMarshal.AsBytes(block));
                for (var i = 0; i < count; i++)
                {
                    if (!float.IsFinite(samples[i])) throw new InvalidDataException("Audio contains nonfinite samples.");
                    ref var sum = ref block[i * lanes + lane];
                    sum += samples[i];
                    if (!float.IsFinite(sum)) throw new InvalidDataException("Mix exceeds floating-point range.");
                }
                mixed.Position = target;
                mixed.Write(MemoryMarshal.AsBytes(block));
                position += count;
            }
        }
        mixed.Position = 0;
        double peak = 0;
        var total = checked(plan.SampleCount * lanes);
        for (long position = 0; position < total;)
        {
            var count = (int)Math.Min(frames.Length, total - position);
            mixed.ReadExactly(MemoryMarshal.AsBytes(frames.AsSpan(0, count)));
            for (var i = 0; i < count; i++) peak = Math.Max(peak, Math.Abs((double)frames[i]));
            position += count;
        }
        var gain = RenderPolicy.Gain(peakPolicy, peak);
        mixed.Position = 0;
        using var wave = new CanonicalWaveWriter(paths.Resolve(output), plan.SampleCount);
        var pcm = new byte[frames.Length * RenderConstants.BytesPerSample];
        for (long position = 0; position < total;)
        {
            var count = (int)Math.Min(frames.Length, total - position);
            mixed.ReadExactly(MemoryMarshal.AsBytes(frames.AsSpan(0, count)));
            for (var i = 0; i < count; i++)
            {
                var value = (short)Math.Clamp(Math.Round(frames[i] * gain * 32767), short.MinValue, short.MaxValue);
                BinaryPrimitives.WriteInt16LittleEndian(pcm.AsSpan(i * 2, 2), value);
            }
            wave.Write(pcm.AsSpan(0, count * RenderConstants.BytesPerSample));
            position += count;
        }
        wave.Complete();
        return (peak, gain);
    }
}

internal sealed class RenderMonoProvider : ISampleProvider
{
    private readonly ISampleProvider source;
    private readonly float[] buffer;
    public WaveFormat WaveFormat { get; }
    public RenderMonoProvider(ISampleProvider source)
    {
        this.source = source;
        buffer = new float[RenderConstants.Block * source.WaveFormat.Channels];
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(source.WaveFormat.SampleRate, 1);
    }
    public int Read(Span<float> destination)
    {
        var channels = source.WaveFormat.Channels;
        var frames = Math.Min(destination.Length, RenderConstants.Block);
        var count = source.Read(buffer.AsSpan(0, frames * channels));
        if (count % channels != 0) throw new InvalidDataException("Decoder returned an incomplete channel frame.");
        for (var frame = 0; frame < count / channels; frame++)
        {
            double value = 0;
            for (var channel = 0; channel < channels; channel++) value += buffer[frame * channels + channel];
            destination[frame] = (float)(value / channels);
        }
        return count / channels;
    }
}

// Canonical output: 16 kHz, 16-bit PCM, RenderConstants.Channels interleaved channels, plain 44-byte RIFF header.
internal sealed class CanonicalWaveWriter : IDisposable
{
    private readonly FileStream stream;
    private readonly long expected;
    public CanonicalWaveWriter(string path, long frames)
    {
        expected = checked(frames * RenderConstants.FrameBytes);
        if (frames < 0 || expected + 36 > uint.MaxValue) throw new InvalidDataException("Output exceeds RIFF size.");
        stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024);
        using var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        writer.Write("RIFF"u8); writer.Write((uint)(36 + expected)); writer.Write("WAVEfmt "u8);
        writer.Write(16u); writer.Write((ushort)1); writer.Write((ushort)RenderConstants.Channels);
        writer.Write(RenderConstants.Rate); writer.Write(RenderConstants.Rate * RenderConstants.FrameBytes);
        writer.Write((ushort)RenderConstants.FrameBytes); writer.Write((ushort)(RenderConstants.BytesPerSample * 8));
        writer.Write("data"u8); writer.Write((uint)expected);
    }
    public void Write(ReadOnlySpan<byte> bytes)
    {
        if (stream.Position - 44 + bytes.Length > expected) throw new InvalidDataException("Output overflow.");
        stream.Write(bytes);
    }
    public void Complete()
    {
        if (stream.Position != expected + 44) throw new InvalidDataException("Output is incomplete.");
        stream.Flush(flushToDisk: true);
    }
    public void Dispose() => stream.Dispose();
}
