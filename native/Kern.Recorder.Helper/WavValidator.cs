using System.Buffers.Binary;

namespace Kern.Recorder.Helper;

internal static class WavValidator
{
    public const int HeaderLength = 44;

    public static long Validate(string path, long? expectedAudioBytes = null)
    {
        using var stream = File.OpenRead(path);
        if (stream.Length < HeaderLength) throw new InvalidDataException("WAV segment is too short.");
        Span<byte> header = stackalloc byte[12];
        stream.ReadExactly(header);
        if (!header[..4].SequenceEqual("RIFF"u8) && !header[..4].SequenceEqual("RF64"u8))
            throw new InvalidDataException("WAV segment has no RIFF header.");
        if (!header[8..12].SequenceEqual("WAVE"u8))
            throw new InvalidDataException("WAV segment has no WAVE signature.");

        long? dataLength = null;
        Span<byte> chunkHeader = stackalloc byte[8];
        while (stream.Position + 8 <= stream.Length)
        {
            stream.ReadExactly(chunkHeader);
            var length = BinaryPrimitives.ReadUInt32LittleEndian(chunkHeader[4..]);
            if (chunkHeader[..4].SequenceEqual("data"u8))
            {
                dataLength = length;
                break;
            }
            var next = checked(stream.Position + length + (length & 1));
            if (next > stream.Length) throw new InvalidDataException("WAV chunk exceeds the file.");
            stream.Position = next;
        }

        if (dataLength is null) throw new InvalidDataException("WAV segment has no data chunk.");
        if (expectedAudioBytes is not null && dataLength != expectedAudioBytes)
            throw new InvalidDataException("WAV data length does not match captured bytes.");
        if (stream.Position + dataLength > stream.Length) throw new InvalidDataException("WAV data chunk is truncated.");
        return dataLength.Value;
    }
}
