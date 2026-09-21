using System.Text.Json;

namespace Kern.Recorder.Helper;

// Final render of a finished session. The live (in-call) mode lives in CallRenderer.Live.cs.
internal static partial class CallRenderer
{
    public static RenderManifest Render(string sessionDirectory)
    {
        using var paths = new RenderPaths(sessionDirectory);
        // Source validation precedes touching derived files. Active capture is never repaired here.
        var plan = RenderValidation.Load(paths);
        paths.CreateDirectory("derived");
        using var renderLock = AcquireLock(paths);
        var peakPolicy = RenderPolicy.Read(paths);
        var cached = RenderArtifacts.Cached(paths, plan, peakPolicy);
        if (cached is not null) return cached;
        EnsureFreeSpace(paths, plan);
        RenderManifest? previous = null;
        try { previous = JsonSerializer.Deserialize<RenderManifest>(paths.ReadBytes("derived/manifest.json", RenderConstants.MaxManifestBytes), Protocol.JsonOptions); }
        catch (Exception error) when (error is IOException or JsonException) { }
        var previousWindows = previous?.Windows ?? RenderArtifacts.PublishedWindows(paths);
        // Absence of this commit marker means outputs must not be consumed.
        File.Delete(paths.Resolve("derived/manifest.json"));
        DeletePartials(paths);
        var token = Guid.NewGuid().ToString("N");
        var scratch = $"derived/mix-{token}.partial";
        var audio = $"derived/call-{token}.partial";
        var temporaryManifest = $"derived/manifest-{token}.partial";
        var temporaryFiles = new List<string> { scratch, audio, temporaryManifest };
        try
        {
            var (peak, gain) = RenderMixer.Mix(paths, plan, scratch, audio, peakPolicy);
            var candidate = RenderArtifacts.Describe(paths, audio) with { RelativePath = "derived/call.wav" };
            var keepAudio = false;
            try { keepAudio = previous?.Audio == candidate && RenderArtifacts.Describe(paths, "derived/call.wav") == candidate; }
            catch (IOException) { }
            if (keepAudio) File.Delete(paths.Resolve(audio));
            else paths.Publish(audio, "derived/call.wav");
            var windows = RenderArtifacts.Windows(paths, "derived/call.wav", plan.SampleCount, complete: true,
                temporaryFiles.Add, previousWindows);
            var verified = RenderValidation.Load(paths);
            if (verified.Fingerprint != plan.Fingerprint)
                throw new InvalidDataException("Source manifest changed during render.");
            var manifest = new RenderManifest(1, RenderConstants.Version, plan.Session.SessionId, plan.Fingerprint,
                RenderConstants.Rate, 1, 16, plan.SampleCount, (double)plan.SampleCount / RenderConstants.Rate,
                "verified", plan.Warnings, plan.Inputs.Select(input => new RenderSource(input.Segment.SegmentId,
                    input.Segment.RelativePath, input.Segment.ByteLength, input.Segment.Sha256)).ToArray(),
                RenderPolicy.Describe(peakPolicy), peak, gain, RenderArtifacts.Describe(paths, "derived/call.wav"), windows, true);
            WriteJson(paths, temporaryManifest, manifest);
            paths.Publish(temporaryManifest, "derived/manifest.json");
            return manifest;
        }
        finally
        {
            DeleteTemporaries(paths, temporaryFiles);
        }
    }

    private static FileStream AcquireLock(RenderPaths paths) =>
        new(paths.Resolve("derived/render.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);

    private static void EnsureFreeSpace(RenderPaths paths, RenderPlan plan)
    {
        var driveRoot = Path.GetPathRoot(paths.Root) ?? throw new IOException("Render volume is unavailable.");
        var requiredBytes = checked(plan.SampleCount * 9 + 64L * 1024 * 1024);
        if (new DriveInfo(driveRoot).AvailableFreeSpace < requiredBytes)
            throw new IOException("Insufficient free space for bounded offline rendering.");
    }

    // Leftovers of a render that died mid-flight. Safe under the render lock.
    private static void DeletePartials(RenderPaths paths)
    {
        foreach (var partial in Directory.EnumerateFiles(paths.Resolve("derived"), "*.partial"))
            File.Delete(paths.Resolve("derived/" + Path.GetFileName(partial)));
    }

    private static void DeleteTemporaries(RenderPaths paths, IEnumerable<string> relatives)
    {
        foreach (var relative in relatives)
        {
            try { File.Delete(paths.Resolve(relative)); }
            catch (IOException) { }
        }
    }

    private static void WriteJson<T>(RenderPaths paths, string temporary, T value)
    {
        using var stream = new FileStream(paths.Resolve(temporary), FileMode.CreateNew, FileAccess.Write, FileShare.None);
        JsonSerializer.Serialize(stream, value, Protocol.JsonOptions);
        stream.Flush(flushToDisk: true);
    }
}
