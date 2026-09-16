using System.Buffers.Binary;

namespace Kern.Recorder.Helper;

internal static class RenderWaveValidation
{
    // Validate chunk bounds before passing input to the NAudio decoder.
    public static void Validate(Stream stream, SegmentManifest segment, TrackFormat format)
    {
        stream.Position = 0;
        Span<byte> header = stackalloc byte[12];
        stream.ReadExactly(header);
        if (!header[..4].SequenceEqual("RIFF"u8) || !header[8..].SequenceEqual("WAVE"u8) ||
            BinaryPrimitives.ReadUInt32LittleEndian(header[4..8]) + 8L != stream.Length)
            throw new InvalidDataException("Invalid source RIFF size or signature.");
        Span<byte> chunk = stackalloc byte[8];
        Span<byte> fmt = stackalloc byte[40];
        var sawFormat = false;
        var sawData = false;
        while (stream.Position < stream.Length)
        {
            if (stream.Length - stream.Position < 8) throw new InvalidDataException("Truncated WAV chunk.");
            stream.ReadExactly(chunk);
            var length = BinaryPrimitives.ReadUInt32LittleEndian(chunk[4..]);
            var next = checked(stream.Position + length + (length & 1));
            if (next > stream.Length) throw new InvalidDataException("Truncated WAV data.");
            if (chunk[..4].SequenceEqual("fmt "u8))
            {
                if (sawFormat || length is not (16 or 18 or 40)) throw new InvalidDataException("Unsupported WAV format chunk.");
                sawFormat = true;
                stream.ReadExactly(fmt[..(int)length]);
                var tag = BinaryPrimitives.ReadUInt16LittleEndian(fmt);
                var expectedTag = format.Encoding switch { "Pcm" => 1, "IeeeFloat" => 3, "Extensible" => 65534, _ => -1 };
                if (tag != expectedTag) throw new InvalidDataException("WAV encoding does not match metadata.");
                if (tag == 65534)
                {
                    if (length != 40 || BinaryPrimitives.ReadUInt16LittleEndian(fmt[16..]) != 22 ||
                        BinaryPrimitives.ReadUInt16LittleEndian(fmt[18..]) != format.ValidBitsPerSample ||
                        BinaryPrimitives.ReadInt32LittleEndian(fmt[20..]) != format.ChannelMask ||
                        !Guid.TryParse(format.SubFormat, out var sub) || new Guid(fmt[24..40]) != sub)
                        throw new InvalidDataException("Extensible WAV format does not match metadata.");
                }
                else if (length == 40 || (length == 18 && BinaryPrimitives.ReadUInt16LittleEndian(fmt[16..]) != 0))
                    throw new InvalidDataException("Unsupported WAV extra format data.");
            }
            else if (chunk[..4].SequenceEqual("data"u8))
            {
                if (!sawFormat || sawData || length != checked(segment.SampleCount * format.BlockAlign))
                    throw new InvalidDataException("Invalid WAV sample length or duplicate data.");
                sawData = true;
            }
            else if (length > 1024 * 1024)
                throw new InvalidDataException("Oversized WAV metadata chunk.");
            stream.Position = next;
        }
        if (!sawFormat || !sawData) throw new InvalidDataException("WAV lacks format or data.");
        stream.Position = 0;
    }
}
