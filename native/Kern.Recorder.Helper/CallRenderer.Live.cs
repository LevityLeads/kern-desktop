namespace Kern.Recorder.Helper;

// Live render of a session that is still recording: mix [0, throughMs) to a temporary call file, publish
// only the windows that are already complete, and describe them in derived/live-manifest.json.
// derived/call.wav and derived/manifest.json are never written here; the final Render owns them.
internal static partial class CallRenderer
{
    public static RenderLiveManifest RenderThrough(string sessionDirectory, long throughMs)
    {
        using var paths = new RenderPaths(sessionDirectory);
        var plan = RenderValidation.Load(paths, throughMs);
        paths.CreateDirectory("derived");
        using var renderLock = AcquireLock(paths);
        EnsureFreeSpace(paths, plan);
        var previousWindows = RenderArtifacts.PublishedWindows(paths);
        DeletePartials(paths);
        var token = Guid.NewGuid().ToString("N");
        // Pin before mixing: every window published from here on must stay byte-stable through the final render.
        RenderPolicy.PinClamp(paths, token);
        var peakPolicy = RenderPolicy.Read(paths);
        if (peakPolicy != RenderPeakPolicy.Clamp)
            throw new InvalidDataException("Live rendering requires the clamp peak policy pin.");
        var scratch = $"derived/mix-{token}.partial";
        var audio = $"derived/call-{token}.partial";
        var temporaryManifest = $"derived/live-manifest-{token}.partial";
        var temporaryFiles = new List<string> { scratch, audio, temporaryManifest };
        try
        {
            RenderMixer.Mix(paths, plan, scratch, audio, peakPolicy);
            var windows = RenderArtifacts.Windows(paths, audio, plan.SampleCount, complete: false,
                temporaryFiles.Add, previousWindows);
            var manifest = new RenderLiveManifest(1, RenderConstants.Version, plan.Session.SessionId, plan.Fingerprint,
                plan.SampleCount, RenderConstants.Rate, RenderConstants.Channels, 16, RenderConstants.ChannelRoles, RenderPolicy.Name(peakPolicy), windows, false);
            WriteJson(paths, temporaryManifest, manifest);
            paths.Publish(temporaryManifest, "derived/live-manifest.json");
            return manifest;
        }
        finally
        {
            DeleteTemporaries(paths, temporaryFiles);
        }
    }
}
