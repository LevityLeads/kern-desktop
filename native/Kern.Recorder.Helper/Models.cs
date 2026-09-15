namespace Kern.Recorder.Helper;

internal sealed record HelperOptions(string PipeName, int ParentProcessId, int ProtocolVersion)
{
    public static HelperOptions Parse(string[] args)
    {
        string? pipeName = null;
        int? parentPid = null;
        int? protocolVersion = null;
        for (var index = 0; index < args.Length; index += 2)
        {
            if (index + 1 >= args.Length) throw new ArgumentException("Every helper option requires a value.");
            switch (args[index])
            {
                case "--pipe": pipeName = args[index + 1]; break;
                case "--parent-pid": parentPid = int.Parse(args[index + 1], System.Globalization.CultureInfo.InvariantCulture); break;
                case "--protocol": protocolVersion = int.Parse(args[index + 1], System.Globalization.CultureInfo.InvariantCulture); break;
                default: throw new ArgumentException($"Unknown helper option: {args[index]}");
            }
        }

        if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Length > 100 || pipeName.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
            throw new ArgumentException("Invalid pipe name.");
        if (parentPid is null or < 1) throw new ArgumentException("Invalid parent process ID.");
        if (protocolVersion != Protocol.Version) throw new ArgumentException("Incompatible protocol version.");
        return new HelperOptions(pipeName, parentPid.Value, protocolVersion.Value);
    }
}

internal sealed record MicrophoneSelection(string Mode, string? DeviceId);
internal sealed record StartRequest(string SessionId, string SessionPath, MicrophoneSelection Microphone, int SegmentDurationMs);
internal sealed record RecoverRequest(string SessionId, string SessionPath);
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

internal sealed record TrackFormat(
    int SampleRate,
    int Channels,
    int BitsPerSample,
    int BlockAlign,
    int AverageBytesPerSecond,
    string Encoding,
    int? ValidBitsPerSample,
    int? ChannelMask,
    string? SubFormat);

internal sealed class TrackManifest
{
    public required string TrackId { get; init; }
    public required string EndpointId { get; init; }
    public required string Name { get; init; }
    public required string Kind { get; init; }
    public required IReadOnlyList<string> DefaultRoles { get; set; }
    public required TrackFormat Format { get; init; }
    public long Generation { get; set; }
    public string Health { get; set; } = "unknown";
    public string? Message { get; set; }
}

internal sealed class SegmentManifest
{
    public required string SegmentId { get; init; }
    public required string TrackId { get; init; }
    public required int Sequence { get; init; }
    public required string RelativePath { get; init; }
    public required string Status { get; set; }
    public required long Generation { get; init; }
    public required long TimelineStartTicks { get; init; }
    public required long TimelineEndTicks { get; init; }
    public required long SampleCount { get; init; }
    public required long ByteLength { get; init; }
    public required string Sha256 { get; init; }
    public required long? FirstDevicePosition { get; init; }
    public required long? FirstQpcPosition { get; init; }
    public required long? LastDevicePosition { get; init; }
    public required long? LastQpcPosition { get; init; }
    public required string PublishedAtUtc { get; init; }
}

internal sealed record GapManifest(
    string GapId,
    string Scope,
    string Reason,
    long StartTicks,
    long? EndTicks,
    string Provenance,
    long Generation);

internal sealed class SessionManifest
{
    public int ProtocolVersion { get; init; } = Protocol.Version;
    public int ManifestVersion { get; init; } = 1;
    public required string SessionId { get; init; }
    public required string State { get; set; }
    public required string StartedAtUtc { get; init; }
    public string? EndedAtUtc { get; set; }
    public long TimelineFrequency { get; init; }
    public long DurationMs { get; set; }
    public long SizeBytes { get; set; }
    public long CaptureGeneration { get; set; } = 1;
    public bool MicMuted { get; set; }
    public List<TrackManifest> Tracks { get; init; } = [];
    public List<SegmentManifest> Segments { get; init; } = [];
    public List<GapManifest> Gaps { get; init; } = [];
    public object? Failure { get; set; }
}

internal sealed record TrackStatus(
    string TrackId,
    string Name,
    string Kind,
    string Health,
    double Peak,
    long SampleCount,
    long DroppedFrames,
    long LastHeartbeatTicks,
    long LastWriteTicks,
    IReadOnlyList<string> DefaultRoles,
    string? Message);

internal sealed record RecorderStatus(
    string State,
    string? SessionId,
    bool MicMuted,
    string? StartedAtUtc,
    long EffectiveElapsedMs,
    long? FreeBytes,
    IReadOnlyList<TrackStatus> Tracks,
    object? Failure = null,
    string? Message = null,
    long? EffectiveCutoffTicks = null);
