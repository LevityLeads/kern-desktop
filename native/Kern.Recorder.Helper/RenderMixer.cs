using System.Buffers.Binary;
using System.Runtime.InteropServices;
using NAudio.Wave;
using NAudio.Wave.SampleProviders;

namespace Kern.Recorder.Helper;

internal static class RenderMixer
{
    // A disk-backed accumulator and one decoder keep audio memory block-bounded.
    // Samples [0, plan.SampleCount) never depend on source audio past that point: runs are read in
    // order from their start and cut at the plan end, so a live render and the final render agree.
    public static (double Peak, double Gain) Mix(RenderPaths paths, RenderPlan plan, string scratch, string output,
        RenderPeakPolicy peakPolicy = RenderPeakPolicy.GlobalGain)
    {
        using var mixed = new FileStream(paths.Resolve(scratch), FileMode.CreateNew,
            FileAccess.ReadWrite, FileShare.None, 64 * 1024);
        mixed.SetLength(checked(plan.SampleCount * sizeof(float)));
        var samples = new float[RenderConstants.Block];
        var sums = new float[RenderConstants.Block];
        foreach (var run in RenderRuns.Group(plan.Inputs))
        {
            if (run.StartSample >= plan.SampleCount) continue;
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
                var target = checked((run.StartSample + position) * sizeof(float));
                mixed.Position = target;
                mixed.ReadExactly(MemoryMarshal.AsBytes(sums.AsSpan(0, count)));
                for (var i = 0; i < count; i++)
                {
                    if (!float.IsFinite(samples[i])) throw new InvalidDataException("Audio contains nonfinite samples.");
                    sums[i] += samples[i];
                    if (!float.IsFinite(sums[i])) throw new InvalidDataException("Mix exceeds floating-point range.");
                }
                mixed.Position = target;
                mixed.Write(MemoryMarshal.AsBytes(sums.AsSpan(0, count)));
                position += count;
            }
        }
        mixed.Position = 0;
        double peak = 0;
        for (long position = 0; position < plan.SampleCount;)
        {
            var count = (int)Math.Min(samples.Length, plan.SampleCount - position);
            mixed.ReadExactly(MemoryMarshal.AsBytes(samples.AsSpan(0, count)));
            for (var i = 0; i < count; i++) peak = Math.Max(peak, Math.Abs((double)samples[i]));
            position += count;
        }
        var gain = RenderPolicy.Gain(peakPolicy, peak);
        mixed.Position = 0;
        using var wave = new CanonicalWaveWriter(paths.Resolve(output), plan.SampleCount);
        var pcm = new byte[samples.Length * 2];
        for (long position = 0; position < plan.SampleCount;)
        {
            var count = (int)Math.Min(samples.Length, plan.SampleCount - position);
            mixed.ReadExactly(MemoryMarshal.AsBytes(samples.AsSpan(0, count)));
            for (var i = 0; i < count; i++)
            {
                var value = (short)Math.Clamp(Math.Round(samples[i] * gain * 32767), short.MinValue, short.MaxValue);
                BinaryPrimitives.WriteInt16LittleEndian(pcm.AsSpan(i * 2, 2), value);
            }
            wave.Write(pcm.AsSpan(0, count * 2));
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

internal sealed class CanonicalWaveWriter : IDisposable
{
    private readonly FileStream stream;
    private readonly long expected;
    public CanonicalWaveWriter(string path, long samples)
    {
        expected = checked(samples * 2);
        if (samples < 0 || expected + 36 > uint.MaxValue) throw new InvalidDataException("Output exceeds RIFF size.");
        stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024);
        using var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        writer.Write("RIFF"u8); writer.Write((uint)(36 + expected)); writer.Write("WAVEfmt "u8);
        writer.Write(16u); writer.Write((ushort)1); writer.Write((ushort)1);
        writer.Write(RenderConstants.Rate); writer.Write(RenderConstants.Rate * 2);
        writer.Write((ushort)2); writer.Write((ushort)16); writer.Write("data"u8); writer.Write((uint)expected);
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
