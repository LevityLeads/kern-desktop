using NAudio.CoreAudioApi;

namespace Kern.Recorder.Helper;

internal interface ICaptureTrack : IDisposable
{
    string TrackId { get; }
    string EndpointId { get; }
    string Kind { get; }
    long Generation { get; }
    bool IsRetired { get; }
    bool IsCapturing { get; }
    bool HasWriterFailure { get; }
    TrackManifest ToManifest();
    TrackStatus Status(long nowTicks);
    void Start();
    void Stop(long cutoffTicks);
    void PauseAtFence(long cutoffTicks);
    void ResumeAtFence(long cutoffTicks);
    void ApplyMicrophoneFence(bool enabled, long cutoffTicks, string reason);
    void UpdateDefaultRoles(IReadOnlyList<string> roles);
    void RetireEndpoint(long cutoffTicks, string reason);
}

internal interface ICaptureBackend
{
    event EventHandler? Changed;
    DeviceList List();
    HashSet<string> DefaultRenderIds();
    HashSet<string> ActiveCaptureIds();
    string ResolveMicrophoneId(MicrophoneSelection selection);
    IReadOnlyList<string> DefaultRoles(string id, string kind);
    ICaptureTrack CreateTrack(string endpointId, string kind, string sessionPath, TimelineClock clock,
        int segmentDurationMs, CaptureFence fence, Action<SegmentManifest> onSegment,
        Action<ICaptureTrack, Exception> onFailure);
}

internal sealed class WasapiCaptureBackend(AudioDevices devices) : ICaptureBackend
{
    public event EventHandler? Changed { add => devices.Changed += value; remove => devices.Changed -= value; }
    public DeviceList List() => devices.List();
    public HashSet<string> DefaultRenderIds() => devices.DefaultRenderIds();
    public HashSet<string> ActiveCaptureIds() => devices.ActiveCaptureIds();
    public string ResolveMicrophoneId(MicrophoneSelection selection)
    {
        using var device = devices.ResolveMicrophone(selection);
        return device.ID;
    }
    public IReadOnlyList<string> DefaultRoles(string id, string kind) =>
        devices.DefaultRoles(id, kind == "render" ? DataFlow.Render : DataFlow.Capture);
    public ICaptureTrack CreateTrack(string endpointId, string kind, string sessionPath, TimelineClock clock,
        int segmentDurationMs, CaptureFence fence, Action<SegmentManifest> onSegment,
        Action<ICaptureTrack, Exception> onFailure)
    {
        var device = devices.OpenDevice(endpointId);
        try { return new CaptureTrack(device, kind, sessionPath, clock, segmentDurationMs,
            fence, DefaultRoles(endpointId, kind), onSegment, onFailure); }
        catch { device.Dispose(); throw; }
    }
}
