using System.Text.Json;
using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class LiveRenderTests
{
    private const int Rate = RenderConstants.Rate;

    // Two endpoints in 5 s segments, both carrying non-constant tones so resampling state is real.
    private static void AddCall(RenderFixture fixture, long fromMs, long toMs, float amplitude)
    {
        for (var start = fromMs; start < toMs; start += 5000)
        {
            fixture.Add(amplitude, startMs: start, durationMs: 5000, rate: 48000, channels: 2, floating: true, trackId: "system", tone: true);
            fixture.Add(amplitude, startMs: start, durationMs: 5000, trackId: "mic", tone: true, kind: "microphone");
        }
    }

    private static RenderFixture Recording(long durationMs)
    {
        var fixture = new RenderFixture(durationMs);
        fixture.Session.State = "recording";
        fixture.Session.EndedAtUtc = null;
        return fixture;
    }

    [Fact]
    public void LiveRenderPublishesOnlyCompleteWindowsAndFinalRenderReproducesThem()
    {
        using var fixture = Recording(200_000);
        AddCall(fixture, 0, 200_000, 0.3f);
        var live = fixture.RenderThrough(130_000);

        Assert.False(live.Complete);
        Assert.Equal(130_000L * 16, live.ThroughSamples);
        Assert.Equal("clamp", live.PeakPolicy);
        Assert.Equal(2, live.Windows.Count);
        Assert.Equal(0, live.Windows[0].StartSeconds);
        Assert.Equal(61, live.Windows[0].EndSeconds);
        Assert.Equal(59, live.Windows[1].StartSeconds);
        Assert.Equal(121, live.Windows[1].EndSeconds);
        Assert.True(File.Exists(fixture.Derived("live-manifest.json")));
        Assert.True(File.Exists(fixture.Derived("window-000000.wav")));
        Assert.True(File.Exists(fixture.Derived("window-000001.wav")));
        Assert.False(File.Exists(fixture.Derived("window-000002.wav")));
        Assert.False(File.Exists(fixture.Derived("manifest.json")));
        Assert.False(File.Exists(fixture.Derived("call.wav")));
        Assert.Empty(Directory.GetFiles(fixture.Derived(""), "*.partial"));
        using (var policy = JsonDocument.Parse(File.ReadAllText(fixture.Derived("render-policy.json"))))
        {
            Assert.Equal(1, policy.RootElement.GetProperty("version").GetInt32());
            Assert.Equal("clamp", policy.RootElement.GetProperty("peakPolicy").GetString());
        }
        using (var document = JsonDocument.Parse(File.ReadAllText(fixture.Derived("live-manifest.json"))))
        {
            Assert.Equal("complete", document.RootElement.EnumerateObject().Last().Name);
            Assert.False(document.RootElement.GetProperty("complete").GetBoolean());
            Assert.Equal(2, document.RootElement.GetProperty("windows").GetArrayLength());
        }
        foreach (var window in live.Windows)
            Assert.Equal(window.Sha256, fixture.HashFile(window.RelativePath));
        // Both endpoints reach the published audio: the tones are not silent and vary sample to sample.
        var published = File.ReadAllBytes(fixture.Derived("window-000001.wav"));
        var distinct = Enumerable.Range(0, 400).Select(i => BitConverter.ToInt16(published, 44 + i * 2)).Distinct().Count();
        Assert.True(distinct > 50, $"window 1 carries only {distinct} distinct sample values");
        Assert.Equal(2, live.Channels);
        Assert.Equal(["microphone", "playback"], live.ChannelRoles);
        // Each side of the call sits on its own channel of the published window.
        var mic = Enumerable.Range(0, 400).Select(i => fixture.Sample("derived/window-000001.wav", i, RenderConstants.MicrophoneLane)).Count(v => v != 0);
        var playback = Enumerable.Range(0, 400).Select(i => fixture.Sample("derived/window-000001.wav", i, RenderConstants.PlaybackLane)).Count(v => v != 0);
        Assert.True(mic > 300 && playback > 300, $"mic {mic}, playback {playback} non-zero of 400");

        // The call gets loud after the live point: two playback endpoints at 0.9 sum past full scale on the
        // playback channel. A global peak gain would rescale everything before it.
        AddCall(fixture, 200_000, 230_000, 0.9f);
        for (var start = 200_000; start < 230_000; start += 5000)
            fixture.Add(0.9f, startMs: start, durationMs: 5000, trackId: "speakers", tone: true);
        fixture.Session.DurationMs = 230_000;
        fixture.Session.State = "stopped";
        fixture.Session.EndedAtUtc = DateTimeOffset.UtcNow.ToString("O");
        var final = fixture.Render();

        Assert.True(final.SourcePeak > 1);
        Assert.Equal(1, final.Gain);
        Assert.Contains("live-pinned", final.PeakPolicy);
        Assert.Equal(4, final.Windows.Count);
        Assert.True(File.Exists(fixture.Derived("call.wav")));
        for (var index = 0; index < live.Windows.Count; index++)
        {
            Assert.Equal(live.Windows[index].Sha256, final.Windows[index].Sha256);
            Assert.Equal(live.Windows[index].ByteLength, final.Windows[index].ByteLength);
            Assert.Equal(live.Windows[index].Sha256, fixture.HashFile(final.Windows[index].RelativePath));
        }
    }

    [Fact]
    public void LiveRenderRejectsThroughBeyondAvailableAudio()
    {
        using var fixture = Recording(10_000);
        AddCall(fixture, 0, 10_000, 0.3f);
        Assert.Throws<InvalidDataException>(() => fixture.RenderThrough(10_001));
        Assert.False(Directory.Exists(fixture.Derived("")));
        Assert.Throws<InvalidDataException>(() => fixture.RenderThrough(0));
        Assert.Throws<InvalidDataException>(() => fixture.RenderThrough(-5));
        Assert.Empty(fixture.RenderThrough(10_000).Windows);
    }

    [Fact]
    public void LiveRenderIsIdempotentAndIncremental()
    {
        using var fixture = Recording(135_000);
        for (var start = 0; start < 135_000; start += 5000)
            fixture.Add(0.4f, startMs: start, durationMs: 5000, trackId: "mic", tone: true);
        var first = fixture.RenderThrough(70_000);
        Assert.Single(first.Windows);
        var window0 = fixture.Derived("window-000000.wav");
        var bytes = File.ReadAllBytes(window0);
        var pinned = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(window0, pinned);

        var second = fixture.RenderThrough(130_000);
        Assert.Equal(2, second.Windows.Count);
        Assert.Equal(first.Windows[0], second.Windows[0]);
        Assert.Equal(bytes, File.ReadAllBytes(window0));
        Assert.Equal(pinned, File.GetLastWriteTimeUtc(window0));
        Assert.True(File.Exists(fixture.Derived("window-000001.wav")));
        Assert.Equal(second.Windows[1].Sha256, fixture.HashFile(second.Windows[1].RelativePath));

        var third = fixture.RenderThrough(130_000);
        Assert.Equal(second.Windows, third.Windows);
        Assert.Equal(pinned, File.GetLastWriteTimeUtc(window0));
    }

    [Fact]
    public void LiveRenderStillRejectsUnfinalisedSegmentsAndHeldLock()
    {
        using var fixture = Recording(10_000);
        var segment = fixture.Add(0.3f, durationMs: 10_000, tone: true);
        segment.Status = "writing";
        Assert.Throws<InvalidDataException>(() => fixture.RenderThrough(5_000));
        segment.Status = "finalised";
        Directory.CreateDirectory(fixture.Derived(""));
        using (new FileStream(fixture.Derived("render.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
            Assert.Throws<IOException>(() => fixture.RenderThrough(5_000));
        Assert.False(File.Exists(fixture.Derived("live-manifest.json")));
        Assert.False(File.Exists(fixture.Derived("render-policy.json")));
    }

    [Fact]
    public void FinalRenderWithoutLivePinKeepsGlobalPeakGain()
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.9f); fixture.Add(0.8f);
        var rendered = fixture.Render();
        Assert.False(File.Exists(fixture.Derived("render-policy.json")));
        Assert.InRange(rendered.Gain, 0.58, 0.60);
        Assert.Contains("global peak gain", rendered.PeakPolicy);
    }
}
