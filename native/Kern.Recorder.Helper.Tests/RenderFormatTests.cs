using System.Text.Json.Nodes;
using System.Security.Cryptography;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class RenderFormatTests
{
    [Fact]
    public void JitteredCaptureCheckpointsRenderThroughRealMetadata()
    {
        using var fixture = new RenderFixture(durationMs: 10000, frequency: TimelineClock.Frequency);
        var wave = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
        var producer = typeof(CaptureTrack).GetMethod("FormatInfo",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
        var format = (TrackFormat)producer.Invoke(null, [wave])!;
        fixture.Session.Tracks.Add(new TrackManifest { TrackId = "render-pipeline", EndpointId = "test",
            Name = "test", Kind = "render", DefaultRoles = [], Format = format, Generation = 1 });
        using (var processor = new CapturePacketProcessor(fixture.Root, "render-pipeline", wave, 5000, 1024,
            new TimelineClock(), fixture.Session.Segments.Add, (error, _) => throw error))
        {
            for (var i = 0; i < 1000; i++)
            {
                var bytes = new byte[480 * 8];
                for (var sample = 0; sample < 960; sample++)
                    BitConverter.GetBytes(0.25f).CopyTo(bytes, sample * 4);
                var ticks = TimelineClock.DurationForFrames(i * 480L, 48000);
                var jitter = i % 2 == 0 ? 0 : TimelineClock.Frequency / 10000;
                Assert.True(processor.TryEnqueue(new AudioPacket(bytes, i * 480L, 10000 + i * 100000L,
                    ticks + jitter, 1, 1, ObservedAtTicks: ticks + TimelineClock.Frequency / 50)));
            }
            processor.Flush(TimelineClock.Frequency * 10, 1);
        }
        Assert.Equal(2, fixture.Session.Segments.Count);
        fixture.Render();
        Assert.InRange(fixture.Sample(8000), 8170, 8200);
        Assert.InRange(fixture.Sample(152000), 8170, 8200);
    }

    [Theory]
    [InlineData("pcm", false)]
    [InlineData("ieeefloat", false)]
    [InlineData("extensible", false)]
    [InlineData("pcm", true)]
    [InlineData("ieeefloat", true)]
    [InlineData("extensible", true)]
    public void RealCaptureMetadataRendersIncludingLegacyCasing(string encoding, bool legacyCasing)
    {
        using var fixture = new RenderFixture();
        var source = fixture.Add(0.2f);
        WaveFormat wave = encoding switch
        {
            "pcm" => new WaveFormat(48000, 16, 2),
            "ieeefloat" => WaveFormat.CreateIeeeFloatWaveFormat(48000, 2),
            _ => new WaveFormatExtensible(48000, 32, 2, true, 32, 3),
        };
        var path = Path.Combine(fixture.Root, source.RelativePath);
        using (var writer = new WaveFileWriter(path, wave))
        {
            var samples = Enumerable.Repeat(0.25f, wave.SampleRate * wave.Channels).ToArray();
            writer.WriteSamples(samples, 0, samples.Length);
        }
        var producer = typeof(CaptureTrack).GetMethod("FormatInfo",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
        var format = (TrackFormat)producer.Invoke(null, [wave])!;
        Assert.Equal(encoding, format.Encoding);
        if (legacyCasing) format = format with { Encoding = wave.Encoding.ToString() };
        fixture.Save();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        var node = JsonNode.Parse(File.ReadAllText(manifestPath))!;
        node["tracks"]![0]!["format"] = System.Text.Json.JsonSerializer.SerializeToNode(format, Protocol.JsonOptions);
        var segment = node["segments"]![0]!;
        segment["sampleCount"] = wave.SampleRate;
        segment["byteLength"] = new FileInfo(path).Length;
        using (var stream = File.OpenRead(path))
            segment["sha256"] = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        File.WriteAllText(manifestPath, node.ToJsonString());
        CallRenderer.Render(fixture.Root);
        Assert.InRange(fixture.Sample(8000), 8170, 8200);
    }

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
