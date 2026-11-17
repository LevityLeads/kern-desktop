namespace Kern.Recorder.Helper;

// The engine's only view of Windows audio, so its state machine runs under test with fakes.
internal interface ICaptureBackend
{
    event EventHandler? DevicesChanged;
    DeviceList ListDevices();
    ICaptureSource OpenMicrophone(MicrophoneSelection selection);
    // Active render endpoints, id to friendly name.
    IReadOnlyDictionary<string, string> ActiveRenderEndpoints();
    ICaptureSource OpenEndpointLoopback(string endpointId);
}

internal sealed class WasapiCaptureBackend(AudioDevices devices) : ICaptureBackend
{
    public event EventHandler? DevicesChanged { add => devices.Changed += value; remove => devices.Changed -= value; }

    public DeviceList ListDevices() => devices.List();

    public ICaptureSource OpenMicrophone(MicrophoneSelection selection) =>
        WasapiCaptureSource.Open(devices.ResolveMicrophone(selection), loopback: false);

    public IReadOnlyDictionary<string, string> ActiveRenderEndpoints() => devices.ActiveRenderEndpoints();

    public ICaptureSource OpenEndpointLoopback(string endpointId) =>
        WasapiCaptureSource.Open(devices.OpenActiveRenderDevice(endpointId), loopback: true);
}
