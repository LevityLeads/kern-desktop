using System.Buffers.Binary;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class SourceConverterTests
{
    private const double ToneHz = 1000;
    private const double Amplitude = 0.5;

    public static TheoryData<int, int, string> Formats()
    {
        var data = new TheoryData<int, int, string>();
        foreach (var rate in new[] { 44_100, 48_000 })
        foreach (var channels in new[] { 1, 2, 6, 16 })
        foreach (var encoding in new[] { "float", "int16", "int24", "int32" })
            data.Add(rate, channels, encoding);
        return data;
    }

    [Theory]
    [MemberData(nameof(Formats))]
    public void ConvertsSineToMono16kWithoutLosingSamplesOrPitch(int rate, int channels, string encoding)
    {
        var format = Build(rate, channels, encoding);
        var converter = new SourceConverter(format);
        var output = new List<float>();
        var packetFrames = rate / 100;
        long position = 0;
        for (var packet = 0; packet < 100; packet++)
        {
            // Every packet one frame longer or shorter now and then, like real WASAPI periods.
            var frames = packetFrames + (packet % 7 == 0 ? 1 : 0);
            output.AddRange(converter.Convert(Encode(format, encoding, position, frames), silent: false).ToArray());
            position += frames;
        }

        var expected = position * CallAudio.SampleRate / (double)rate;
        Assert.InRange(output.Count, expected - 40, expected + 1);
        var steady = output.Skip(200).Take(output.Count - 400).ToArray();
        Assert.InRange(steady.Max(), Amplitude * 0.97, Amplitude * 1.03);
        Assert.InRange(steady.Min(), -Amplitude * 1.03, -Amplitude * 0.97);
        // Zero crossings pin the pitch: a 1 kHz tone crosses twice per millisecond.
        var crossings = steady.Zip(steady.Skip(1)).Count(pair => pair.First < 0 != pair.Second < 0);
        var expectedCrossings = steady.Length / (double)CallAudio.SampleRate * ToneHz * 2;
        Assert.InRange(crossings, expectedCrossings - 2, expectedCrossings + 2);
    }

    [Fact]
    public void SilentPacketsConvertToZerosOfTheSameLength()
    {
        var format = WaveFormat.CreateIeeeFloatWaveFormat(48_000, 2);
        var loud = new SourceConverter(format);
        var quiet = new SourceConverter(format);
        for (var packet = 0; packet < 10; packet++)
        {
            var bytes = Encode(format, "float", packet * 480L, 480);
            var converted = loud.Convert(bytes, silent: false).ToArray();
            var silenced = quiet.Convert(bytes, silent: true).ToArray();
            Assert.Equal(converted.Length, silenced.Length);
            Assert.All(silenced, sample => Assert.Equal(0f, sample));
        }
    }

    [Fact]
    public void SixteenKilohertzInt16PassesThroughBitExact()
    {
        var converter = new SourceConverter(new WaveFormat(CallAudio.SampleRate, 16, 1));
        var bytes = new byte[6];
        BinaryPrimitives.WriteInt16LittleEndian(bytes, short.MinValue);
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(2), 12345);
        BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(4), short.MaxValue);

        var output = converter.Convert(bytes, silent: false).ToArray();

        Assert.Equal([-1f, 12345 / 32768f, short.MaxValue / 32768f], output);
    }

    [Fact]
    public void AveragesChannelsAndScrubsNonFiniteFloats()
    {
        var converter = new SourceConverter(WaveFormat.CreateIeeeFloatWaveFormat(CallAudio.SampleRate, 2));
        var bytes = new byte[16];
        BinaryPrimitives.WriteSingleLittleEndian(bytes, 0.5f);
        BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(4), -0.1f);
        BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(8), float.NaN);
        BinaryPrimitives.WriteSingleLittleEndian(bytes.AsSpan(12), 0.4f);

        var output = converter.Convert(bytes, silent: false).ToArray();

        Assert.Equal(0.2f, output[0], 6);
        Assert.Equal(0.2f, output[1], 6);
    }

    [Fact]
    public void RejectsFormatsItCannotDecode()
    {
        Assert.Throws<NotSupportedException>(() => new SourceConverter(new WaveFormat(48_000, 8, 1)));
        Assert.Throws<NotSupportedException>(() => new SourceConverter(WaveFormat.CreateALawFormat(8000, 1)));
    }

    private static WaveFormat Build(int rate, int channels, string encoding) => encoding switch
    {
        // Extensible, as WASAPI mix formats are; int24 as 24 valid bits in a 32-bit container
        // is covered by the int32 decode path.
        "float" => new WaveFormatExtensible(rate, 32, channels, AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT, 32, 0),
        "int32" => new WaveFormatExtensible(rate, 32, channels, AudioMediaSubtypes.MEDIASUBTYPE_PCM, 24, 0),
        "int24" => new WaveFormat(rate, 24, channels),
        _ => new WaveFormat(rate, 16, channels),
    };

    private static byte[] Encode(WaveFormat format, string encoding, long startFrame, int frames)
    {
        var bytes = new byte[frames * format.BlockAlign];
        var width = format.BitsPerSample / 8;
        for (var frame = 0; frame < frames; frame++)
        {
            var value = Amplitude * Math.Sin(2 * Math.PI * ToneHz * (startFrame + frame) / format.SampleRate);
            for (var channel = 0; channel < format.Channels; channel++)
            {
                var span = bytes.AsSpan(frame * format.BlockAlign + channel * width);
                switch (encoding)
                {
                    case "float": BinaryPrimitives.WriteSingleLittleEndian(span, (float)value); break;
                    case "int32": BinaryPrimitives.WriteInt32LittleEndian(span, (int)(value * int.MaxValue)); break;
                    case "int24":
                        var sample = (int)(value * 8_388_607);
                        span[0] = (byte)sample;
                        span[1] = (byte)(sample >> 8);
                        span[2] = (byte)(sample >> 16);
                        break;
                    default: BinaryPrimitives.WriteInt16LittleEndian(span, (short)(value * short.MaxValue)); break;
                }
            }
        }
        return bytes;
    }
}
