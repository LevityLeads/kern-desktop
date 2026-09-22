namespace Kern.Recorder.Helper;

internal sealed record RenderArtifact(string RelativePath, long ByteLength, string Sha256);
internal sealed record RenderWindow(
    string WindowId, string RelativePath, long ByteLength, string Sha256,
    long StartSample, long EndSample, long CoreStartSample, long CoreEndSample,
    double StartSeconds, double EndSeconds, double CoreStartSeconds, double CoreEndSeconds);
internal sealed record RenderSource(string SegmentId, string RelativePath, long ByteLength, string Sha256);
// ChannelRoles names what each interleaved channel of the rendered audio carries, in channel order:
// channel 0 is every microphone track summed (Rees), channel 1 is every playback endpoint summed (them).
// The split is what lets the transcriber label speakers by source instead of guessing from a mono mix.
internal sealed record RenderManifest(
    int Version, string RendererVersion, string SessionId, string SourceFingerprint,
    int SampleRate, int Channels, int BitsPerSample, IReadOnlyList<string> ChannelRoles, long SampleCount, double DurationSeconds,
    string SourceIntegrity, IReadOnlyList<string> Warnings, IReadOnlyList<RenderSource> Sources,
    string PeakPolicy, double SourcePeak, double Gain, RenderArtifact Audio,
    IReadOnlyList<RenderWindow> Windows, bool Complete);
// Live render: only the windows already complete at ThroughSamples are published; nothing is finalised.
internal sealed record RenderLiveManifest(
    int Version, string RendererVersion, string SessionId, string SourceFingerprint, long ThroughSamples,
    int SampleRate, int Channels, int BitsPerSample, IReadOnlyList<string> ChannelRoles, string PeakPolicy,
    IReadOnlyList<RenderWindow> Windows, bool Complete);
internal sealed record RenderPolicyDocument(int Version, string PeakPolicy);
internal enum RenderPeakPolicy { GlobalGain, Clamp }
// Lane is the output channel this source is summed into (see RenderConstants.ChannelRoles).
internal sealed record RenderInput(SegmentManifest Segment, TrackFormat Format, int Lane, long StartSample, long SampleCount);
// Live is true when SampleCount was truncated to a requested render point of an unfinished session.
internal sealed record RenderPlan(SessionManifest Session, string Fingerprint, long SampleCount,
    IReadOnlyList<RenderInput> Inputs, List<string> Warnings, bool Live = false);

internal static class RenderConstants
{
    public const int Rate = 16000;
    public const int Channels = 2;
    public const int BytesPerSample = 2;
    public const int FrameBytes = Channels * BytesPerSample;
    public const int MicrophoneLane = 0;
    public const int PlaybackLane = 1;
    public static readonly IReadOnlyList<string> ChannelRoles = ["microphone", "playback"];
    public const int Block = 4096;
    public const int CoreSeconds = 60;
    public const int OverlapSeconds = 1;
    // Bumped from render-1 (mono) so every cached mono render is rebuilt rather than reused.
    public const string Version = "kern-call-render-2";
    public const long MaxSamples = 12L * 60 * 60 * Rate;
    public const int MaxManifestBytes = 32 * 1024 * 1024;
    public const int MaxPolicyBytes = 4 * 1024;
    public const long MaxSegmentBytes = 128L * 1024 * 1024;

    public static int LaneFor(string? kind) => kind switch
    {
        "microphone" => MicrophoneLane,
        "render" => PlaybackLane,
        _ => throw new InvalidDataException("Unsupported source track kind."),
    };
}
