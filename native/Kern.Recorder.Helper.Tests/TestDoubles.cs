using System.Buffers.Binary;
using System.Diagnostics;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

// A hand-cranked clock. Raw values start well above zero so QPC conversions stay positive.
internal sealed class FakeClock
{
    public long Raw { get; set; } = Stopwatch.Frequency * 1000;
    public TimelineClock Timeline { get; }

    public FakeClock() => Timeline = new TimelineClock(() => Raw);

    public void Advance(TimeSpan span) => Raw += (long)((Int128)span.Ticks * Stopwatch.Frequency / TimeSpan.TicksPerSecond);

    // The QPC stamp WASAPI would report for a raw timestamp.
    public static long ToQpc100Nanoseconds(long raw) => (long)((Int128)raw * 10_000_000 / Stopwatch.Frequency);
}

internal static class Pcm
{
    public static readonly WaveFormat Mono16k = new(CallAudio.SampleRate, 16, 1);

    public static byte[] Int16(int frames, short value)
    {
        var bytes = new byte[frames * 2];
        for (var i = 0; i < frames; i++) BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(i * 2), value);
        return bytes;
    }

    public static (short Me, short Them) Frame(ReadOnlySpan<byte> audio, long frame) => (
        BinaryPrimitives.ReadInt16LittleEndian(audio[(int)(frame * 4)..]),
        BinaryPrimitives.ReadInt16LittleEndian(audio[(int)(frame * 4 + 2)..]));
}

internal sealed class FakeSource(string name, WaveFormat format) : ICaptureSource
{
    private PacketHandler? onPacket;
    private Action<Exception>? onFailed;

    public string Name { get; } = name;
    public WaveFormat Format { get; } = format;
    public bool Started { get; private set; }
    public bool Disposed { get; private set; }
    public bool Live => Started && !Disposed;

    public void Start(PacketHandler onPacket, Action<Exception> onFailed)
    {
        this.onPacket = onPacket;
        this.onFailed = onFailed;
        Started = true;
    }

    public void Emit(byte[] packet, bool silent = false, long? qpc = null)
    {
        if (Live) onPacket!(packet, silent, qpc);
    }

    public void Fail(Exception error) => onFailed!(error);

    public void Dispose() => Disposed = true;
}

internal sealed class FakeBackend : ICaptureBackend
{
    public event EventHandler? DevicesChanged;

    public List<FakeSource> Opened { get; } = [];
    public Dictionary<string, string> Endpoints { get; } = new(StringComparer.Ordinal);
    public bool ProcessLoopbackWorks { get; set; } = true;
    public int MicrophoneFailuresLeft { get; set; }
    public HashSet<string> MissingMicrophones { get; } = [];
    public List<MicrophoneSelection> MicrophoneRequests { get; } = [];
    public WaveFormat Format { get; set; } = Pcm.Mono16k;

    public IEnumerable<FakeSource> Live => Opened.Where(source => source.Live);
    public FakeSource? Microphone => Opened.LastOrDefault(source => source.Live && source.Name.StartsWith("Mic", StringComparison.Ordinal));

    public DeviceList ListDevices() => new([], []);

    public ICaptureSource OpenMicrophone(MicrophoneSelection selection)
    {
        MicrophoneRequests.Add(selection);
        if (MicrophoneFailuresLeft > 0)
        {
            MicrophoneFailuresLeft--;
            throw new InvalidOperationException("Microphone is unavailable.");
        }
        if (selection.DeviceId is string id && MissingMicrophones.Contains(id))
            throw new ProtocolException("microphone-unavailable", "Chosen microphone is unavailable.");
        return Track(new FakeSource(selection.Mode == "default" ? "Mic (default)" : $"Mic ({selection.DeviceId})", Format));
    }

    public ICaptureSource OpenProcessLoopback(int excludedProcessId)
    {
        if (!ProcessLoopbackWorks) throw new InvalidOperationException("Process loopback is not supported.");
        return Track(new FakeSource(WasapiCaptureSource.ProcessLoopbackName, Format));
    }

    public IReadOnlyDictionary<string, string> ActiveRenderEndpoints() => new Dictionary<string, string>(Endpoints);

    public ICaptureSource OpenEndpointLoopback(string endpointId) =>
        Endpoints.TryGetValue(endpointId, out var name)
            ? Track(new FakeSource(name, Format))
            : throw new InvalidOperationException("Playback device is not active.");

    public void RaiseDevicesChanged() => DevicesChanged?.Invoke(this, EventArgs.Empty);

    private FakeSource Track(FakeSource source)
    {
        Opened.Add(source);
        return source;
    }
}

// Real file sink with an injectable failure, so engine tests exercise the actual CallWriter.
internal sealed class FailingSink(ICallSink inner) : ICallSink
{
    public bool FailAppends { get; set; }

    public void Append(ReadOnlySpan<byte> frames)
    {
        if (FailAppends) throw new IOException("The device is not ready.");
        inner.Append(frames);
    }

    public void Flush(bool toDisk) => inner.Flush(toDisk);
    public void CloseAudio() => inner.CloseAudio();
    public void WriteSession(SessionDocument document) => inner.WriteSession(document);
    public void Dispose() => inner.Dispose();
}

internal sealed class MemorySink : ICallSink
{
    public MemoryStream Audio { get; } = new();
    public int DurableFlushes { get; private set; }
    public bool AudioClosed { get; private set; }
    public bool FailAppends { get; set; }

    public void Append(ReadOnlySpan<byte> frames)
    {
        if (FailAppends) throw new IOException("Disk full.");
        Audio.Write(frames);
    }

    public void Flush(bool toDisk)
    {
        if (toDisk) DurableFlushes++;
    }

    public void CloseAudio() => AudioClosed = true;
    public void WriteSession(SessionDocument document) { }
    public void Dispose() { }
}
