using System.Buffers.Binary;
using NAudio.Dsp;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

// Turns one source's packets, in whatever format WASAPI hands over, into mono 16 kHz float.
// One instance per opened stream: the resampler carries filter state across packets, so a
// packet boundary never produces a click or a dropped sample.
internal sealed class SourceConverter
{
    private enum SampleKind { Float32, Pcm16, Pcm24, Pcm32 }

    private readonly SampleKind kind;
    private readonly int channels;
    private readonly int bytesPerSample;
    private readonly WdlResampler? resampler;
    private readonly double outputPerInput;
    private float[] output = new float[1024];

    public SourceConverter(WaveFormat format)
    {
        ArgumentNullException.ThrowIfNull(format);
        if (format.Channels < 1 || format.SampleRate < 8000 || format.SampleRate > 384_000)
            throw new NotSupportedException($"Unsupported capture format: {format}.");
        kind = Classify(format);
        channels = format.Channels;
        bytesPerSample = format.BitsPerSample / 8;
        BlockAlign = format.BlockAlign;
        if (BlockAlign != channels * bytesPerSample)
            throw new NotSupportedException($"Unsupported capture block alignment: {format}.");
        outputPerInput = (double)CallAudio.SampleRate / format.SampleRate;
        if (format.SampleRate != CallAudio.SampleRate)
        {
            // Windowed sinc rather than WDL's IIR mode: downsampling 48 kHz speech to 16 kHz
            // needs a steep anti-alias cut, and the IIR mode lets a 12 kHz tone alias through
            // at about -23 dB where sinc leaves nothing measurable.
            resampler = new WdlResampler();
            resampler.SetMode(false, 0, true, 64, 32);
            resampler.SetFeedMode(true);
            resampler.SetRates(format.SampleRate, CallAudio.SampleRate);
        }
    }

    public int BlockAlign { get; }

    // Returns the converted samples for this packet. The span stays valid until the next call.
    // A trailing partial frame (never seen from WASAPI, but not worth trusting) is ignored.
    public ReadOnlySpan<float> Convert(ReadOnlySpan<byte> packet, bool silent)
    {
        var frames = packet.Length / BlockAlign;
        if (frames == 0) return [];
        if (resampler is null)
        {
            EnsureOutput(frames);
            Mixdown(packet, output.AsSpan(0, frames), silent);
            return output.AsSpan(0, frames);
        }

        var wanted = resampler.ResamplePrepare(frames, 1, out var input);
        if (wanted != frames) throw new InvalidOperationException("Resampler refused a capture packet.");
        Mixdown(packet, input[..frames], silent);
        EnsureOutput((int)Math.Ceiling(frames * outputPerInput) + 64);
        var produced = resampler.ResampleOut(output, frames, output.Length, 1);
        return output.AsSpan(0, produced);
    }

    private void EnsureOutput(int length)
    {
        if (output.Length < length) output = new float[Math.Max(length, output.Length * 2)];
    }

    // Channel average, so a mono microphone exposed as a stereo pair is not doubled and a 5.1
    // stream keeps its dialogue centre without clipping.
    private void Mixdown(ReadOnlySpan<byte> packet, Span<float> destination, bool silent)
    {
        if (silent)
        {
            destination.Clear();
            return;
        }
        var scale = 1f / channels;
        for (var frame = 0; frame < destination.Length; frame++)
        {
            var offset = frame * BlockAlign;
            var sum = 0f;
            for (var channel = 0; channel < channels; channel++, offset += bytesPerSample)
                sum += Read(packet, offset);
            destination[frame] = sum * scale;
        }
    }

    private float Read(ReadOnlySpan<byte> packet, int offset)
    {
        switch (kind)
        {
            case SampleKind.Float32:
                var value = BinaryPrimitives.ReadSingleLittleEndian(packet[offset..]);
                return float.IsFinite(value) ? value : 0f;
            case SampleKind.Pcm16:
                return BinaryPrimitives.ReadInt16LittleEndian(packet[offset..]) / 32768f;
            case SampleKind.Pcm24:
                var raw = packet[offset] | (packet[offset + 1] << 8) | (packet[offset + 2] << 16);
                return ((raw << 8) >> 8) / 8388608f;
            default:
                return BinaryPrimitives.ReadInt32LittleEndian(packet[offset..]) / 2147483648f;
        }
    }

    // Extensible formats declare their real encoding in SubFormat; a 24-bit-valid stream in a
    // 32-bit container is read as int32 because WASAPI left-justifies the valid bits.
    private static SampleKind Classify(WaveFormat format)
    {
        var encoding = format.Encoding;
        if (format is WaveFormatExtensible extensible)
        {
            if (extensible.SubFormat == AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT) encoding = WaveFormatEncoding.IeeeFloat;
            else if (extensible.SubFormat == AudioMediaSubtypes.MEDIASUBTYPE_PCM) encoding = WaveFormatEncoding.Pcm;
        }
        return (encoding, format.BitsPerSample) switch
        {
            (WaveFormatEncoding.IeeeFloat, 32) => SampleKind.Float32,
            (WaveFormatEncoding.Pcm, 16) => SampleKind.Pcm16,
            (WaveFormatEncoding.Pcm, 24) => SampleKind.Pcm24,
            (WaveFormatEncoding.Pcm, 32) => SampleKind.Pcm32,
            _ => throw new NotSupportedException($"Unsupported capture format: {format}."),
        };
    }
}
