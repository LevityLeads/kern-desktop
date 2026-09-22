namespace Kern.Recorder.Helper;

// The engine's only view of Windows audio, so its state machine runs under test with fakes.
internal interface ICaptureBackend
{
    event EventHandler? DevicesChanged;
    DeviceList ListDevices();
    ICaptureSource OpenMicrophone(MicrophoneSelection selection);
    ICaptureSource OpenProcessLoopback(int excludedProcessId);
    // Active render endpoints, id to friendly name.
    IReadOnlyDictionary<string, string> ActiveRenderEndpoints();
    ICaptureSource OpenEndpointLoopback(string endpointId);
}

internal sealed class WasapiCaptureBackend(AudioDevices devices) : ICaptureBackend
{
    // Activation normally completes in milliseconds. A wedged audio service must not hold the
    // start command hostage; endpoint loopback is the fallback either way.
    private static readonly TimeSpan ProcessLoopbackTimeout = TimeSpan.FromSeconds(5);

    public event EventHandler? DevicesChanged { add => devices.Changed += value; remove => devices.Changed -= value; }

    public DeviceList ListDevices() => devices.List();

    public ICaptureSource OpenMicrophone(MicrophoneSelection selection) =>
        WasapiCaptureSource.Open(devices.ResolveMicrophone(selection), loopback: false);

    public ICaptureSource OpenProcessLoopback(int excludedProcessId)
    {
        var activation = WasapiCaptureSource.OpenProcessLoopbackAsync(excludedProcessId);
        try { return activation.WaitAsync(ProcessLoopbackTimeout).GetAwaiter().GetResult(); }
        catch (TimeoutException)
        {
            _ = activation.ContinueWith(late => late.Result.Dispose(), CancellationToken.None,
                TaskContinuationOptions.OnlyOnRanToCompletion, TaskScheduler.Default);
            throw;
        }
    }

    public IReadOnlyDictionary<string, string> ActiveRenderEndpoints() => devices.ActiveRenderEndpoints();

    public ICaptureSource OpenEndpointLoopback(string endpointId) =>
        WasapiCaptureSource.Open(devices.OpenActiveRenderDevice(endpointId), loopback: true);
}
