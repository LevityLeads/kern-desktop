using System.Text.Json;
using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class CallRendererTests
{
    [Fact]
    public void MixesRatesAndIndependentEndpointsWithoutSilentTrackAttenuation()
    {
        using var fixture = new RenderFixture(2000, origin: 91_000_000);
        fixture.Add(0.2f, startMs: 500, rate: 48000, channels: 2, floating: true);
        fixture.Add(0.3f, startMs: 500, rate: 44100);
        fixture.Add(0f, startMs: 500, rate: 32000, channels: 2);
        var rendered = fixture.Render();
        Assert.Equal(32000, rendered.SampleCount);
        Assert.Equal(1, rendered.Gain);
        Assert.Equal(0, fixture.Sample(1000));
        Assert.InRange(fixture.Sample(16000), 16370, 16390);
        Assert.Equal(0, fixture.Sample(31000));
        Assert.Equal(32000 * RenderConstants.FrameBytes + 44, rendered.Audio.ByteLength);
        Assert.Equal(2, rendered.Channels);
        Assert.Equal(["microphone", "playback"], rendered.ChannelRoles);
    }

    [Fact]
    public void MicrophoneAndPlaybackLandOnSeparateChannelsInCallAndWindows()
    {
        using var fixture = new RenderFixture(2000);
        fixture.Add(0.3f, durationMs: 2000, trackId: "mic", kind: "microphone");
        fixture.Add(0.2f, durationMs: 2000, rate: 48000, channels: 2, floating: true, trackId: "headset", kind: "render");
        fixture.Add(0.1f, durationMs: 2000, trackId: "speakers", kind: "render");
        var rendered = fixture.Render();
        Assert.Equal(1, rendered.Gain);
        // Channel 0 carries only the microphone; channel 1 sums every playback endpoint.
        Assert.InRange(fixture.Sample(16000, RenderConstants.MicrophoneLane), 9800, 9900);
        Assert.InRange(fixture.Sample(16000, RenderConstants.PlaybackLane), 9800, 9900);
        Assert.InRange(fixture.Sample(1000, RenderConstants.MicrophoneLane), 9800, 9900);
        var window = rendered.Windows[0];
        Assert.Equal(44 + (window.EndSample - window.StartSample) * RenderConstants.FrameBytes, window.ByteLength);
        Assert.InRange(fixture.Sample(window.RelativePath, 16000, RenderConstants.MicrophoneLane), 9800, 9900);
        Assert.InRange(fixture.Sample(window.RelativePath, 16000, RenderConstants.PlaybackLane), 9800, 9900);
    }

    [Fact]
    public void UnknownTrackKindIsRejectedBeforeRendering()
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.1f, kind: "loopback"); fixture.Save();
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
        Assert.False(Directory.Exists(Path.Combine(fixture.Root, "derived")));
    }

    [Fact]
    public void OverlappingSpeechIsPeakProtectedWithoutAmplifyingSilence()
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.9f); fixture.Add(0.8f); fixture.Add(0f);
        var rendered = fixture.Render();
        Assert.InRange(rendered.SourcePeak, 1.69, 1.71);
        Assert.InRange(rendered.Gain, 0.58, 0.60);
        Assert.InRange(fixture.Sample(4000), 32700, 32766);
    }

    [Fact]
    public void GapsBetweenSameTrackRunsRemainSilent()
    {
        using var fixture = new RenderFixture(4000);
        fixture.Add(0.2f, trackId: "a");
        fixture.Add(0.4f, startMs: 3000, trackId: "a");
        fixture.Render();
        Assert.InRange(fixture.Sample(5000), 6500, 6600);
        Assert.Equal(0, fixture.Sample(32000));
        Assert.InRange(fixture.Sample(56000), 13000, 13200);
    }

    [Fact]
    public void WindowsHaveStableOverlapCoreOwnershipAndRepeatRenderUsesCache()
    {
        using var fixture = new RenderFixture(125000);
        fixture.Add(0.25f, startMs: 59000, durationMs: 3000);
        var first = fixture.Render();
        Assert.Equal(3, first.Windows.Count);
        var middle = first.Windows[1];
        Assert.Equal(59, middle.StartSeconds);
        Assert.Equal(121, middle.EndSeconds);
        Assert.Equal(60, middle.CoreStartSeconds);
        Assert.Equal(120, middle.CoreEndSeconds);
        var audioPath = Path.Combine(fixture.Root, first.Audio.RelativePath);
        File.SetLastWriteTimeUtc(audioPath, new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        var before = File.GetLastWriteTimeUtc(audioPath);
        var second = CallRenderer.Render(fixture.Root);
        Assert.Equal(first.Audio.Sha256, second.Audio.Sha256);
        Assert.Equal(before, File.GetLastWriteTimeUtc(audioPath));
        File.WriteAllBytes(Path.Combine(fixture.Root, middle.RelativePath), [1, 2, 3]);
        var repaired = CallRenderer.Render(fixture.Root);
        Assert.Equal(first.Windows[1].Sha256, repaired.Windows[1].Sha256);
        Assert.Equal(first.Audio.Sha256, repaired.Audio.Sha256);
        Assert.Equal(before, File.GetLastWriteTimeUtc(audioPath));
    }

    [Fact]
    public void TwoHourMarkerRetainsAbsoluteSamplePositionWithBoundedMemory()
    {
        using var fixture = new RenderFixture(7_201_000);
        fixture.Add(0.3f, startMs: 7_200_000, durationMs: 1000);
        var manifest = fixture.Render();
        Assert.Equal(121, manifest.Windows.Count);
        Assert.Equal(0, fixture.Sample(7199L * 16000));
        Assert.InRange(fixture.Sample(7200L * 16000 + 8000), 9800, 9900);
        Assert.Equal(7201, manifest.DurationSeconds);
    }

    [Fact]
    public void LegacyManifestsWarnWithoutPretendingToRecoverMissingTiming()
    {
        using var fixture = new RenderFixture(3000, version: 1);
        fixture.Add(0.3f, startMs: 2000);
        var rendered = fixture.Render();
        Assert.Contains(rendered.Warnings, warning => warning.StartsWith("legacy-timing-uncertain", StringComparison.Ordinal));
        Assert.Equal(0, fixture.Sample(16000));
        Assert.InRange(fixture.Sample(40000), 9800, 9900);
    }

    [Theory]
    [InlineData("recording")]
    [InlineData("paused")]
    [InlineData("degraded")]
    public void RejectsLiveManifests(string state)
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.1f); fixture.Session.State = state; fixture.Save();
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
        Assert.False(Directory.Exists(Path.Combine(fixture.Root, "derived")));
    }

    [Fact]
    public void RejectsCorruptedSourcesEvenIfDerivedCacheLooksComplete()
    {
        using var fixture = new RenderFixture();
        var segment = fixture.Add(0.2f); fixture.Render();
        using (var stream = new FileStream(Path.Combine(fixture.Root, segment.RelativePath), FileMode.Open, FileAccess.Write))
        { stream.Position = stream.Length - 1; stream.WriteByte(255); }
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
    }

    [Fact]
    public void SourceFormatMismatchAndUnfinalizedSegmentsAreRejected()
    {
        using var fixture = new RenderFixture();
        var segment = fixture.Add(0.1f); segment.Status = "writing"; fixture.Save();
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
        segment.Status = "finalised";
        var track = fixture.Session.Tracks[0];
        fixture.Session.Tracks[0] = new TrackManifest { TrackId = track.TrackId, EndpointId = track.EndpointId,
            Name = track.Name, Kind = track.Kind, DefaultRoles = [], Format = track.Format with { SampleRate = 48000, AverageBytesPerSecond = 96000 } };
        fixture.Save();
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
    }

    [Fact]
    public void OversizeFailsBeforeAnyDerivedOutput()
    {
        using var fixture = new RenderFixture(13 * 60 * 60 * 1000L);
        fixture.Add(0f); fixture.Save();
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
        Assert.False(Directory.Exists(Path.Combine(fixture.Root, "derived")));
    }

    [Fact]
    public void MissingCommitMarkerRegeneratesWithoutChangingOriginals()
    {
        using var fixture = new RenderFixture();
        var source = fixture.Add(0.2f); var first = fixture.Render();
        var manifestBefore = File.ReadAllBytes(Path.Combine(fixture.Root, "manifest.json"));
        File.Delete(Path.Combine(fixture.Root, "derived", "manifest.json"));
        File.WriteAllText(Path.Combine(fixture.Root, "derived", "mix-abandoned.partial"), "incomplete");
        var next = CallRenderer.Render(fixture.Root);
        Assert.Equal(first.Audio, next.Audio);
        Assert.Equal(manifestBefore, File.ReadAllBytes(Path.Combine(fixture.Root, "manifest.json")));
        Assert.Equal(source.RelativePath, next.Sources[0].RelativePath);
        Assert.Empty(Directory.GetFiles(Path.Combine(fixture.Root, "derived"), "*.partial"));
    }

    [Fact]
    public void MalformedCacheIsReplacedAndManifestLastFieldIsComplete()
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.2f); fixture.Render();
        var path = Path.Combine(fixture.Root, "derived", "manifest.json");
        File.WriteAllText(path, "{\"complete\":true}");
        CallRenderer.Render(fixture.Root);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal("complete", document.RootElement.EnumerateObject().Last().Name);
        Assert.True(document.RootElement.GetProperty("complete").GetBoolean());
    }
}
