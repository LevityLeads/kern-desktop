namespace Kern.Recorder.Helper;

internal sealed record RenderArtifact(string RelativePath, long ByteLength, string Sha256);
internal sealed record RenderWindow(
    string WindowId, string RelativePath, long ByteLength, string Sha256,
    long StartSample, long EndSample, long CoreStartSample, long CoreEndSample,
    double StartSeconds, double EndSeconds, double CoreStartSeconds, double CoreEndSeconds);
internal sealed record RenderSource(string SegmentId, string RelativePath, long ByteLength, string Sha256);
internal sealed record RenderManifest(
    int Version, string RendererVersion, string SessionId, string SourceFingerprint,
    int SampleRate, int Channels, int BitsPerSample, long SampleCount, double DurationSeconds,
    string SourceIntegrity, IReadOnlyList<string> Warnings, IReadOnlyList<RenderSource> Sources,
    string PeakPolicy, double SourcePeak, double Gain, RenderArtifact Audio,
    IReadOnlyList<RenderWindow> Windows, bool Complete);
internal sealed record RenderInput(SegmentManifest Segment, TrackFormat Format, long StartSample, long SampleCount);
internal sealed record RenderPlan(SessionManifest Session, string Fingerprint, long SampleCount,
    IReadOnlyList<RenderInput> Inputs, List<string> Warnings);

internal static class RenderConstants
{
    public const int Rate = 16000;
    public const int Block = 4096;
    public const int CoreSeconds = 60;
    public const int OverlapSeconds = 1;
    public const string Version = "kern-call-render-1";
    public const long MaxSamples = 12L * 60 * 60 * Rate;
    public const int MaxManifestBytes = 32 * 1024 * 1024;
    public const long MaxSegmentBytes = 128L * 1024 * 1024;
}
