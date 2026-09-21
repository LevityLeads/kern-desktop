using System.Text.Json;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal static class RenderArtifacts
{
    // Slices callFile ([0, samples) of 16k mono PCM) into published derived/window-NNNNNN.wav files.
    // complete: the audio is the whole call, so the trailing partial window is emitted too. Otherwise
    // only windows with a full second of audio beyond their end are cut, keeping any resampler tail at
    // the truncation point away from a published file. An identical existing file is left untouched.
    public static List<RenderWindow> Windows(RenderPaths paths, string callFile, long samples, bool complete,
        Action<string>? trackTemporary = null, IReadOnlyList<RenderWindow>? previous = null)
    {
        var windows = new List<RenderWindow>();
        var buffer = new byte[64 * 1024];
        using var call = paths.OpenRead(callFile);
        for (long core = 0; core < samples; core += RenderConstants.CoreSeconds * RenderConstants.Rate)
        {
            var coreEnd = Math.Min(samples, core + RenderConstants.CoreSeconds * RenderConstants.Rate);
            var start = Math.Max(0, core - RenderConstants.OverlapSeconds * RenderConstants.Rate);
            var end = Math.Min(samples, coreEnd + RenderConstants.OverlapSeconds * RenderConstants.Rate);
            if (!complete && end + RenderConstants.Rate > samples) break;
            var id = $"window-{windows.Count:D6}";
            var relative = $"derived/{id}.wav";
            var temporary = $"derived/{id}.{Guid.NewGuid():N}.partial";
            trackTemporary?.Invoke(temporary);
            using (var writer = new CanonicalWaveWriter(paths.Resolve(temporary), end - start))
            {
                call.Position = 44 + start * 2;
                var remaining = (end - start) * 2;
                while (remaining > 0)
                {
                    var count = (int)Math.Min(buffer.Length, remaining);
                    call.ReadExactly(buffer.AsSpan(0, count));
                    writer.Write(buffer.AsSpan(0, count));
                    remaining -= count;
                }
                writer.Complete();
            }
            var candidate = Describe(paths, temporary);
            var old = previous?.FirstOrDefault(window => window.WindowId == id);
            var keepExisting = old is not null && old.RelativePath == relative && old.ByteLength == candidate.ByteLength && old.Sha256 == candidate.Sha256;
            if (keepExisting)
            {
                try { keepExisting = Describe(paths, relative) == candidate with { RelativePath = relative }; }
                catch (IOException) { keepExisting = false; }
            }
            if (keepExisting) File.Delete(paths.Resolve(temporary));
            else paths.Publish(temporary, relative);
            var artifact = candidate with { RelativePath = relative };
            windows.Add(new RenderWindow(id, relative, artifact.ByteLength, artifact.Sha256,
                start, end, core, coreEnd, Seconds(start), Seconds(end), Seconds(core), Seconds(coreEnd)));
        }
        return windows;
    }

    public static RenderArtifact Describe(RenderPaths paths, string relative)
    {
        using var stream = paths.OpenRead(relative);
        return new RenderArtifact(relative, stream.Length, RenderValidation.Hash(stream));
    }

    // Windows already published for this session by an earlier render, live or final, or null. Used only
    // to leave byte-identical files untouched; every candidate is re-hashed before being kept.
    public static IReadOnlyList<RenderWindow>? PublishedWindows(RenderPaths paths)
    {
        try
        {
            return JsonSerializer.Deserialize<RenderManifest>(
                paths.ReadBytes("derived/manifest.json", RenderConstants.MaxManifestBytes), Protocol.JsonOptions)?.Windows;
        }
        catch (Exception error) when (error is IOException or JsonException) { }
        try
        {
            return JsonSerializer.Deserialize<RenderLiveManifest>(
                paths.ReadBytes("derived/live-manifest.json", RenderConstants.MaxManifestBytes), Protocol.JsonOptions)?.Windows;
        }
        catch (Exception error) when (error is IOException or JsonException) { return null; }
    }

    public static RenderManifest? Cached(RenderPaths paths, RenderPlan plan, RenderPeakPolicy peakPolicy)
    {
        try
        {
            var manifest = JsonSerializer.Deserialize<RenderManifest>(
                paths.ReadBytes("derived/manifest.json", RenderConstants.MaxManifestBytes), Protocol.JsonOptions);
            if (manifest is null || !manifest.Complete || manifest.Version != 1 ||
                manifest.RendererVersion != RenderConstants.Version || manifest.SourceFingerprint != plan.Fingerprint ||
                manifest.SessionId != plan.Session.SessionId || manifest.SampleCount != plan.SampleCount ||
                manifest.PeakPolicy != RenderPolicy.Describe(peakPolicy) ||
                manifest.SampleRate != RenderConstants.Rate || manifest.Channels != 1 || manifest.BitsPerSample != 16 ||
                manifest.DurationSeconds != Seconds(plan.SampleCount) || manifest.SourceIntegrity != "verified" ||
                manifest.Audio.RelativePath != "derived/call.wav" || manifest.Sources.Count != plan.Inputs.Count ||
                !manifest.Warnings.SequenceEqual(plan.Warnings) || !double.IsFinite(manifest.SourcePeak) ||
                !double.IsFinite(manifest.Gain) || manifest.Gain is <= 0 or > 1)
                return null;
            for (var index = 0; index < plan.Inputs.Count; index++)
            {
                var segment = plan.Inputs[index].Segment;
                var expected = new RenderSource(segment.SegmentId, segment.RelativePath, segment.ByteLength, segment.Sha256);
                if (manifest.Sources[index] != expected) return null;
            }
            if (!Matches(paths, manifest.Audio, plan.SampleCount)) return null;
            var expectedCount = (plan.SampleCount + 60 * RenderConstants.Rate - 1) / (60 * RenderConstants.Rate);
            if (manifest.Windows.Count != expectedCount) return null;
            long core = 0;
            for (var index = 0; index < manifest.Windows.Count; index++)
            {
                var window = manifest.Windows[index];
                var coreEnd = Math.Min(plan.SampleCount, core + 60 * RenderConstants.Rate);
                var start = Math.Max(0, core - RenderConstants.Rate);
                var end = Math.Min(plan.SampleCount, coreEnd + RenderConstants.Rate);
                if (window.WindowId != $"window-{index:D6}" || window.RelativePath != $"derived/window-{index:D6}.wav" ||
                    window.StartSample != start || window.EndSample != end || window.CoreStartSample != core ||
                    window.CoreEndSample != coreEnd || window.StartSeconds != Seconds(start) || window.EndSeconds != Seconds(end) ||
                    window.CoreStartSeconds != Seconds(core) || window.CoreEndSeconds != Seconds(coreEnd) ||
                    !Matches(paths, new RenderArtifact(window.RelativePath, window.ByteLength, window.Sha256), end - start))
                    return null;
                core = coreEnd;
            }
            return manifest;
        }
        catch (Exception error) when (error is IOException or JsonException or ArgumentException or NullReferenceException or OverflowException)
        {
            return null;
        }
    }

    private static bool Matches(RenderPaths paths, RenderArtifact artifact, long samples)
    {
        using var stream = paths.OpenRead(artifact.RelativePath);
        if (artifact.ByteLength != samples * 2 + 44 || stream.Length != artifact.ByteLength ||
            RenderValidation.Hash(stream) != artifact.Sha256) return false;
        stream.Position = 0;
        using var reader = new WaveFileReader(stream);
        return reader.Length == samples * 2 && reader.WaveFormat.Encoding == WaveFormatEncoding.Pcm &&
            reader.WaveFormat.SampleRate == RenderConstants.Rate && reader.WaveFormat.Channels == 1 && reader.WaveFormat.BitsPerSample == 16;
    }
    private static double Seconds(long sample) => (double)sample / RenderConstants.Rate;
}
