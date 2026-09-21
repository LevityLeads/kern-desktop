using System.Text.Json;

namespace Kern.Recorder.Helper;

// derived/render-policy.json pins mixing choices that must not change once any window of a session
// has been published. The only pinned choice today is the peak policy: a live render publishes windows
// before the call ends, so a later loud passage may never rescale earlier samples through a global gain.
internal static class RenderPolicy
{
    public const string RelativePath = "derived/render-policy.json";
    private const string ClampName = "clamp";

    public static RenderPeakPolicy Read(RenderPaths paths)
    {
        byte[] bytes;
        try { bytes = paths.ReadBytes(RelativePath, RenderConstants.MaxPolicyBytes); }
        catch (FileNotFoundException) { return RenderPeakPolicy.GlobalGain; }
        RenderPolicyDocument? document;
        try { document = JsonSerializer.Deserialize<RenderPolicyDocument>(bytes, Protocol.JsonOptions); }
        catch (JsonException error) { throw new InvalidDataException("Malformed render policy.", error); }
        if (document is not { Version: 1, PeakPolicy: ClampName })
            throw new InvalidDataException("Unsupported render policy; refusing to render with an unknown pin.");
        return RenderPeakPolicy.Clamp;
    }

    // Idempotent. Written before any live mix so a crash between mix and publish leaves the pin in place.
    public static void PinClamp(RenderPaths paths, string token)
    {
        if (File.Exists(paths.Resolve(RelativePath))) return;
        var temporary = $"derived/render-policy-{token}.partial";
        using (var stream = new FileStream(paths.Resolve(temporary), FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            JsonSerializer.Serialize(stream, new RenderPolicyDocument(1, ClampName), Protocol.JsonOptions);
            stream.Flush(flushToDisk: true);
        }
        paths.Publish(temporary, RelativePath);
    }

    // Silent endpoints never reduce volume. Without a pin, only an actually clipped sum is attenuated;
    // with the clamp pin, clipped samples saturate in the PCM conversion and nothing is rescaled.
    public static double Gain(RenderPeakPolicy policy, double peak) =>
        policy == RenderPeakPolicy.Clamp || peak <= 1 ? 1 : 0.999 / peak;

    public static string Describe(RenderPeakPolicy policy) => policy switch
    {
        RenderPeakPolicy.Clamp => "sum-tracks; equal-weight channel downmix; clamp above full scale; no gain (live-pinned)",
        _ => "sum-tracks; equal-weight channel downmix; global peak gain only above full scale; no amplification",
    };

    public static string Name(RenderPeakPolicy policy) => policy == RenderPeakPolicy.Clamp ? ClampName : "global-gain";
}
