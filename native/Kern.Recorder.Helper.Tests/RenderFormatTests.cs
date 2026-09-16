using System.Text.Json.Nodes;
using System.Security.Cryptography;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class RenderFormatTests
{
    [Theory]
    [InlineData(16000, 1, 16, false)]
    [InlineData(48000, 2, 32, true)]
    [InlineData(44100, 6, 24, false)]
    public void ExtensibleSourceDecodesWithoutPlatformMediaCodecs(int rate, int channels, int bits, bool floating)
    {
        using var fixture = new RenderFixture();
        var source = fixture.Add(0.2f);
        var path = Path.Combine(fixture.Root, source.RelativePath);
        var wave = new WaveFormatExtensible(rate, bits, channels, floating, bits, 0);
        using (var writer = new WaveFileWriter(path, wave))
        {
            var samples = Enumerable.Repeat(0.25f, rate * channels).ToArray();
            writer.WriteSamples(samples, 0, samples.Length);
        }
        fixture.Save();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        var node = JsonNode.Parse(File.ReadAllText(manifestPath))!;
        var format = node["tracks"]![0]!["format"]!;
        format["sampleRate"] = rate; format["channels"] = channels; format["bitsPerSample"] = bits;
        format["blockAlign"] = wave.BlockAlign; format["averageBytesPerSecond"] = wave.AverageBytesPerSecond;
        format["encoding"] = "Extensible"; format["validBitsPerSample"] = bits;
        format["channelMask"] = 0; format["subFormat"] = wave.SubFormat.ToString();
        var segment = node["segments"]![0]!;
        segment["sampleCount"] = rate; segment["byteLength"] = new FileInfo(path).Length;
        using (var stream = File.OpenRead(path)) segment["sha256"] = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        File.WriteAllText(manifestPath, node.ToJsonString());
        CallRenderer.Render(fixture.Root);
        Assert.InRange(fixture.Sample(8000), 8170, 8200);
        format["validBitsPerSample"] = bits - 1;
        File.WriteAllText(manifestPath, node.ToJsonString());
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
    }
}
