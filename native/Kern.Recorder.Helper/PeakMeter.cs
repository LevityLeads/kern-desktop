using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal static class PeakMeter
{
    public static double Measure(ReadOnlySpan<byte> buffer, WaveFormat format)
    {
        if (buffer.IsEmpty) return 0;
        var encoding = format.Encoding;
        if (format is WaveFormatExtensible extensible)
        {
            if (extensible.SubFormat == AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT)
                encoding = WaveFormatEncoding.IeeeFloat;
            else if (extensible.SubFormat == AudioMediaSubtypes.MEDIASUBTYPE_PCM)
                encoding = WaveFormatEncoding.Pcm;
        }

        return encoding switch
        {
            WaveFormatEncoding.IeeeFloat when format.BitsPerSample == 32 => Float32(buffer),
            WaveFormatEncoding.Pcm when format.BitsPerSample == 16 => Pcm16(buffer),
            WaveFormatEncoding.Pcm when format.BitsPerSample == 24 => Pcm24(buffer),
            WaveFormatEncoding.Pcm when format.BitsPerSample == 32 => Pcm32(buffer),
            _ => 0,
        };
    }

    private static double Float32(ReadOnlySpan<byte> buffer)
    {
        var peak = 0d;
        for (var index = 0; index + 4 <= buffer.Length; index += 4)
        {
            var value = Math.Abs(BitConverter.ToSingle(buffer.Slice(index, 4)));
            if (double.IsFinite(value)) peak = Math.Max(peak, Math.Min(value, 1));
        }
        return peak;
    }

    private static double Pcm16(ReadOnlySpan<byte> buffer)
    {
        var peak = 0d;
        for (var index = 0; index + 2 <= buffer.Length; index += 2)
            peak = Math.Max(peak, Math.Abs(System.Buffers.Binary.BinaryPrimitives.ReadInt16LittleEndian(buffer[index..]) / 32768d));
        return peak;
    }

    private static double Pcm24(ReadOnlySpan<byte> buffer)
    {
        var peak = 0d;
        for (var index = 0; index + 3 <= buffer.Length; index += 3)
        {
            var value = buffer[index] | (buffer[index + 1] << 8) | (buffer[index + 2] << 16);
            if ((value & 0x800000) != 0) value |= unchecked((int)0xff000000);
            peak = Math.Max(peak, Math.Abs(value / 8388608d));
        }
        return peak;
    }

    private static double Pcm32(ReadOnlySpan<byte> buffer)
    {
        var peak = 0d;
        for (var index = 0; index + 4 <= buffer.Length; index += 4)
            peak = Math.Max(peak, Math.Abs(System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(buffer[index..]) / 2147483648d));
        return peak;
    }
}
