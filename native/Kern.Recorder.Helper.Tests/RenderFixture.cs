using System.Security.Cryptography;
using System.Text.Json;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

internal sealed class RenderFixture : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "kern-render-test-" + Guid.NewGuid().ToString("N"));
    public SessionManifest Session { get; }
    public RenderFixture(long durationMs = 1000, int version = 2, long origin = 0, long frequency = 10_000_000)
    {
        Directory.CreateDirectory(Root);
        Session = new SessionManifest
        {
            SessionId = Guid.NewGuid().ToString("D"), State = "stopped", StartedAtUtc = DateTimeOffset.UtcNow.ToString("O"),
            EndedAtUtc = DateTimeOffset.UtcNow.ToString("O"), ManifestVersion = version,
            TimelineFrequency = frequency, TimelineOriginTicks = version == 2 ? origin : null, DurationMs = durationMs,
        };
    }
    public SegmentManifest Add(float amplitude, long startMs = 0, int durationMs = 1000, int rate = 16000,
        int channels = 1, bool floating = false, string? trackId = null)
    {
        var id = Guid.NewGuid().ToString("N");
        trackId ??= Guid.NewGuid().ToString("N");
        var wave = floating ? WaveFormat.CreateIeeeFloatWaveFormat(rate, channels) : new WaveFormat(rate, 16, channels);
        var format = new TrackFormat(rate, channels, wave.BitsPerSample, wave.BlockAlign,
            wave.AverageBytesPerSecond, wave.Encoding.ToString(), null, null, null);
        if (Session.Tracks.All(track => track.TrackId != trackId))
            Session.Tracks.Add(new TrackManifest { TrackId = trackId, EndpointId = trackId, Name = trackId,
                Kind = "render", DefaultRoles = [], Format = format, Generation = 1 });
        var relative = $"segments/{id}.wav";
        Directory.CreateDirectory(Path.Combine(Root, "segments"));
        var path = Path.Combine(Root, relative);
        var frames = (long)rate * durationMs / 1000;
        using (var writer = new WaveFileWriter(path, wave))
        {
            var chunk = new float[channels * Math.Min(4096, frames)];
            Array.Fill(chunk, amplitude);
            for (long remaining = frames * channels; remaining > 0;)
            {
                var count = (int)Math.Min(chunk.Length, remaining);
                writer.WriteSamples(chunk, 0, count);
                remaining -= count;
            }
        }
        using var source = File.OpenRead(path);
        var origin = Session.TimelineOriginTicks ?? 0;
        var segment = new SegmentManifest
        {
            SegmentId = id, TrackId = trackId, Sequence = Session.Segments.Count, RelativePath = relative, Status = "finalised",
            Generation = 1, TimelineStartTicks = origin + startMs * 10_000,
            TimelineEndTicks = origin + (startMs + durationMs) * 10_000, SampleCount = frames, ByteLength = source.Length,
            Sha256 = Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant(), FirstDevicePosition = null,
            LastDevicePosition = null, FirstQpcPosition = null, LastQpcPosition = null, PublishedAtUtc = DateTimeOffset.UtcNow.ToString("O"),
        };
        Session.Segments.Add(segment);
        return segment;
    }
    public void Save() => File.WriteAllBytes(Path.Combine(Root, "manifest.json"), JsonSerializer.SerializeToUtf8Bytes(Session, Protocol.JsonOptions));
    public RenderManifest Render() { Save(); return CallRenderer.Render(Root); }
    public short Sample(long index)
    {
        using var stream = File.OpenRead(Path.Combine(Root, "derived", "call.wav"));
        stream.Position = 44 + index * 2;
        using var reader = new BinaryReader(stream);
        return reader.ReadInt16();
    }
    public void Dispose() => Directory.Delete(Root, recursive: true);
}
