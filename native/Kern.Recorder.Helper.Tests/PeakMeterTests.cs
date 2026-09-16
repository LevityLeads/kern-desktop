using System.Buffers.Binary;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class PeakMeterTests
{
    [Theory]
    [InlineData(-32768, 1d)]
    [InlineData(32767, 32767d / 32768d)]
    [InlineData(-32767, 32767d / 32768d)]
    [InlineData(0, 0d)]
    public void MeasuresSignedPcm16Extrema(int sample, double expected)
    {
        var buffer = new byte[2];
        BinaryPrimitives.WriteInt16LittleEndian(buffer, (short)sample);

        Assert.Equal(expected, PeakMeter.Measure(buffer, new WaveFormat(48000, 16, 1)));
    }

    [Fact]
    public void MeasuresFullScaleNegativeSampleInMixedPcm16Buffer()
    {
        short[] samples = [0, 32767, -32768, -16384, 16384];
        var buffer = new byte[samples.Length * 2];
        for (var index = 0; index < samples.Length; index++)
            BinaryPrimitives.WriteInt16LittleEndian(buffer.AsSpan(index * 2), samples[index]);

        Assert.Equal(1d, PeakMeter.Measure(buffer, new WaveFormat(48000, 16, 1)));
    }
}
