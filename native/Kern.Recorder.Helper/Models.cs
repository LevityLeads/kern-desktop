using System.Text.Json.Serialization;

namespace Kern.Recorder.Helper;

internal sealed record HelperOptions(string PipeName, int ParentProcessId, int ProtocolVersion, string? AppBuild = null)
{
    public static HelperOptions Parse(string[] args)
    {
        string? pipeName = null;
        int? parentPid = null;
        int? protocolVersion = null;
        string? appBuild = null;
        for (var index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length) throw new ArgumentException("Every helper option requires a value.");
            switch (args[index])
            {
                case "--pipe": pipeName = args[index + 1]; break;
                case "--parent-pid": parentPid = int.Parse(args[index + 1], System.Globalization.CultureInfo.InvariantCulture); break;
                case "--protocol": protocolVersion = int.Parse(args[index + 1], System.Globalization.CultureInfo.InvariantCulture); break;
                case "--app-build": appBuild = args[index + 1]; break;
                default: throw new ArgumentException($"Unknown helper option: {args[index]}");
            }
        }

        if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Length > 100 || pipeName.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
            throw new ArgumentException("Invalid pipe name.");
        if (parentPid is null or < 1) throw new ArgumentException("Invalid parent process ID.");
        if (protocolVersion != Protocol.Version) throw new ArgumentException("Incompatible protocol version.");
        // The desktop app's build label (version plus commit), recorded in every session.json so a
        // recording can always be matched to the exact code that produced it.
        if (appBuild is not null && (appBuild.Length is 0 or > 100 ||
            appBuild.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or '+'))))
            throw new ArgumentException("Invalid app build label.");
        return new HelperOptions(pipeName, parentPid.Value, protocolVersion.Value, appBuild);
    }
}

// Which code produced a recording. Read straight off session.json, never inferred.
internal sealed record ProducerInfo(string App, string Helper, int Protocol);

internal sealed record MicrophoneSelection(string Mode, string? DeviceId);
internal sealed record StartRequest(string SessionId, string SessionPath, MicrophoneSelection Microphone);
internal sealed record ControlRequest(long RequestedAtUnixMs, double RequestedAtMonotonicMs, bool? Muted = null, string? Reason = null);

internal sealed record EndpointInfo(
    string Id,
    string Name,
    string Flow,
    string State,
    bool Supported,
    IReadOnlyList<string> DefaultRoles,
    string? Reason = null);

internal sealed record DeviceList(
    IReadOnlyList<EndpointInfo> RenderEndpoints,
    IReadOnlyList<EndpointInfo> CaptureEndpoints);

// Protocol 2 shapes. Nullable members the desktop reads are always written, even as null, so a
// missing key can only ever mean an older helper.

internal sealed record CaptureFailure(string Code, string Message);

// Per source, cumulative for the session: enough to answer "did audio reach this source, and
// did any of it fail to land in audio.pcm" from session.json alone.
internal sealed record SourceStats(
    long Packets,
    long InputFrames,
    long OutputFrames,
    long Gaps,
    long GapFrames,
    long LateFrames,
    long Resyncs,
    long DroppedFrames);

internal sealed record SourceStatus(
    string Id,
    string Lane,
    string Name,
    string Mode,
    string State,
    double Level,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Message,
    SourceStats Stats);

internal sealed record RecorderStatus(
    string State,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? SessionId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? StartedAtUtc,
    long ElapsedMs,
    long CommittedFrames,
    bool MicMuted,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? PlaybackMode,
    IReadOnlyList<SourceStatus> Sources,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] CaptureFailure? Failure,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Warning);

internal sealed record SessionSource(
    string Id,
    string Lane,
    string Name,
    string Mode,
    string State,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Message,
    SourceStats Stats);

internal sealed record PauseSpan(
    long StartFrame,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] long? EndFrame,
    string Reason);

internal sealed record SessionDocument(
    string Format,
    string SessionId,
    string State,
    string StartedAtUtc,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? EndedAtUtc,
    int SampleRate,
    int Channels,
    IReadOnlyList<string> Lanes,
    long CommittedFrames,
    ProducerInfo Producer,
    string PlaybackMode,
    IReadOnlyList<SessionSource> Sources,
    IReadOnlyList<PauseSpan> Pauses,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] CaptureFailure? Failure)
{
    public const string FormatName = "kern-call-audio/1";
}
