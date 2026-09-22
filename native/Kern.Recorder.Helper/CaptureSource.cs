using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

// qpc100Nanoseconds is null when WASAPI flagged the packet's timestamp as unreliable.
internal delegate void PacketHandler(ReadOnlySpan<byte> buffer, bool silent, long? qpc100Nanoseconds);

// One open capture stream. The engine owns its lifetime; everything past the raw packet
// (conversion, placement, mixing) lives in SourcePipeline so it can be tested without Windows.
internal interface ICaptureSource : IDisposable
{
    string Name { get; }
    WaveFormat Format { get; }
    // onFailed may fire on any thread, at most once, and must not block.
    void Start(PacketHandler onPacket, Action<Exception> onFailed);
}

internal sealed class WasapiCaptureSource : ICaptureSource
{
    public const string ProcessLoopbackName = "All apps except Kern";

    private readonly WasapiRecorder recorder;
    private readonly MMDevice? device;
    private PacketHandler? onPacket;
    private Action<Exception>? onFailed;
    private int failed;
    private int disposed;

    private WasapiCaptureSource(WasapiRecorder recorder, MMDevice? device, string name)
    {
        this.recorder = recorder;
        this.device = device;
        Name = name;
    }

    public string Name { get; }
    public WaveFormat Format => recorder.WaveFormat;

    // Takes ownership of the device, including on failure.
    public static WasapiCaptureSource Open(MMDevice device, bool loopback)
    {
        try
        {
            var builder = new WasapiRecorderBuilder().WithDevice(device).WithSharedMode().WithEventSync();
            if (loopback) builder = builder.WithLoopbackCapture();
            return new WasapiCaptureSource(builder.Build(), device, device.FriendlyName);
        }
        catch
        {
            device.Dispose();
            throw;
        }
    }

    // Everything every app renders, on every endpoint, minus the Electron process tree, so
    // Kern's own sounds never reach the "them" lane. Windows 10 2004+; the caller falls back
    // to per-endpoint loopback when activation throws.
    public static async Task<WasapiCaptureSource> OpenProcessLoopbackAsync(int excludedProcessId)
    {
        var recorder = await new WasapiRecorderBuilder()
            .WithProcessLoopback((uint)excludedProcessId, ProcessLoopbackMode.ExcludeTargetProcessTree)
            .WithFormat(WaveFormat.CreateIeeeFloatWaveFormat(48_000, 2))
            .BuildAsync()
            .ConfigureAwait(false);
        return new WasapiCaptureSource(recorder, null, ProcessLoopbackName);
    }

    public void Start(PacketHandler onPacket, Action<Exception> onFailed)
    {
        this.onPacket = onPacket;
        this.onFailed = onFailed;
        recorder.DataAvailable += OnDataAvailable;
        recorder.RecordingStopped += OnRecordingStopped;
        recorder.StartRecording();
    }

    private void OnDataAvailable(ReadOnlySpan<byte> buffer, AudioClientBufferFlags flags, long devicePosition, long qpcPosition)
    {
        var trusted = !flags.HasFlag(AudioClientBufferFlags.TimestampError) && qpcPosition > 0;
        // A throw here would unwind NAudio's capture thread; report it and let the engine
        // reopen the stream instead.
        try { onPacket?.Invoke(buffer, flags.HasFlag(AudioClientBufferFlags.Silent), trusted ? qpcPosition : null); }
        catch (Exception error) { Fail(error); }
    }

    // The handler is detached before Kern stops a stream, so any stop seen here was unasked for.
    private void OnRecordingStopped(object? sender, StoppedEventArgs eventArgs) =>
        Fail(eventArgs.Exception ?? new IOException("Capture stream ended unexpectedly."));

    private void Fail(Exception error)
    {
        if (Volatile.Read(ref disposed) == 0 && Interlocked.Exchange(ref failed, 1) == 0) onFailed?.Invoke(error);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 1) return;
        recorder.DataAvailable -= OnDataAvailable;
        recorder.RecordingStopped -= OnRecordingStopped;
        // An invalidated device rejects StopRecording; there is nothing left to stop.
        try { if (recorder.CaptureState != CaptureState.Stopped) recorder.StopRecording(); }
        catch { }
        recorder.Dispose();
        device?.Dispose();
    }
}
