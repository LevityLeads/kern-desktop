using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal sealed class CaptureTrack : IDisposable
{
    private const int CaptureQueueCapacity = 32;
    private readonly object gate = new();
    private readonly string sessionPath;
    private readonly TimelineClock clock;
    private readonly int segmentDurationMs;
    private readonly Action<SegmentManifest> onSegmentFinalised;
    private readonly Action<CaptureTrack, Exception> onFailure;
    private readonly CaptureFence fence;
    private readonly MMDevice device;
    private readonly WasapiRecorder recorder;
    private readonly CapturePacketProcessor packetProcessor;
    private long generation;
    private long persistenceEpoch = 1;
    private long minimumPersistenceTicks = long.MinValue;
    private bool persist = true;
    private bool disposed;
    private bool retired;
    private bool dataLossDetected;
    private bool writerFailed;
    private long sampleCount;
    private long droppedFrames;
    private long lastHeartbeatTicks;
    private long? expectedDevicePosition;
    private double peak;
    private string health = "unknown";
    private string? message;

    public CaptureTrack(
        MMDevice device,
        string kind,
        string sessionPath,
        TimelineClock clock,
        int segmentDurationMs,
        CaptureFence fence,
        IReadOnlyList<string> defaultRoles,
        Action<SegmentManifest> onSegmentFinalised,
        Action<CaptureTrack, Exception> onFailure)
    {
        this.sessionPath = sessionPath;
        this.clock = clock;
        this.segmentDurationMs = segmentDurationMs;
        this.fence = fence;
        generation = fence.Generation;
        this.onSegmentFinalised = onSegmentFinalised;
        this.onFailure = onFailure;
        this.device = device;
        Kind = kind;
        EndpointId = device.ID;
        Name = device.FriendlyName;
        TrackId = $"{kind}-{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(device.ID)))[..16].ToLowerInvariant()}-{Guid.NewGuid():N}";
        DefaultRoles = defaultRoles;
        recorder = new WasapiRecorderBuilder()
            .WithDevice(device)
            .WithSharedMode()
            .WithEventSync()
            .WithBufferLength(100)
            .ApplyLoopback(kind == "render")
            .Build();
        Format = recorder.WaveFormat;
        packetProcessor = new CapturePacketProcessor(
            sessionPath,
            TrackId,
            Format,
            segmentDurationMs,
            CaptureQueueCapacity,
            clock,
            onSegmentFinalised,
            RecordWriterFailure);
        recorder.DataAvailable += OnDataAvailable;
        recorder.RecordingStopped += OnRecordingStopped;
    }

    public string TrackId { get; }
    public string EndpointId { get; }
    public string Name { get; }
    public string Kind { get; }
    public WaveFormat Format { get; }
    public IReadOnlyList<string> DefaultRoles { get; private set; }
    public long Generation => generation;
    public bool IsRetired => retired;
    public bool IsCapturing => !retired && recorder.CaptureState == CaptureState.Capturing;

    public TrackManifest ToManifest() => new()
    {
        TrackId = TrackId,
        EndpointId = EndpointId,
        Name = Name,
        Kind = Kind,
        DefaultRoles = DefaultRoles,
        Format = FormatInfo(Format),
        Generation = generation,
        Health = health,
        Message = message,
    };

    public void Start()
    {
        lock (gate)
        {
            ThrowIfDisposed();
            health = "healthy-idle";
            lastHeartbeatTicks = clock.NowTicks;
            minimumPersistenceTicks = lastHeartbeatTicks;
            persist = true;
        }
        recorder.StartRecording();
    }

    public void PauseAtFence(long cutoffTicks)
    {
        lock (fence.SyncRoot)
        {
            long endingEpoch;
            lock (gate)
            {
                persist = false;
                endingEpoch = persistenceEpoch;
            }
            FlushAtFence(cutoffTicks, endingEpoch);
            lock (gate)
            {
                generation = fence.Generation;
                if (!dataLossDetected && !writerFailed) health = "healthy-idle";
                message ??= "Paused by Kern.";
                peak = 0;
            }
        }
    }

    public void ResumeAtFence(long cutoffTicks)
    {
        lock (fence.SyncRoot)
        lock (gate)
        {
            generation = fence.Generation;
            persistenceEpoch++;
            minimumPersistenceTicks = cutoffTicks;
            persist = true;
            if (!dataLossDetected && !writerFailed) health = "healthy-idle";
            if (!dataLossDetected && !writerFailed) message = null;
            lastHeartbeatTicks = clock.NowTicks;
        }
    }

    public void ApplyMicrophoneFence(bool enabled, long cutoffTicks, string reason)
    {
        lock (fence.SyncRoot)
        {
            long endingEpoch = 0;
            lock (gate)
            {
                persist = enabled;
                if (enabled)
                {
                    generation = fence.Generation;
                    persistenceEpoch++;
                    minimumPersistenceTicks = cutoffTicks;
                }
                else endingEpoch = persistenceEpoch;
            }
            if (!enabled) FlushAtFence(cutoffTicks, endingEpoch);
            lock (gate)
            {
                if (!enabled) generation = fence.Generation;
                if (!dataLossDetected && !writerFailed) health = "healthy-idle";
                if (!dataLossDetected && !writerFailed) message = enabled ? null : reason;
                if (!enabled) peak = 0;
            }
        }
    }

    public void UpdateDefaultRoles(IReadOnlyList<string> roles)
    {
        lock (gate) DefaultRoles = roles;
    }

    public void RetireEndpoint(long cutoffTicks, string reason)
    {
        lock (fence.SyncRoot)
        {
            long endingEpoch;
            lock (gate)
            {
                if (retired) return;
                retired = true;
                persist = false;
                endingEpoch = persistenceEpoch;
            }

            recorder.DataAvailable -= OnDataAvailable;
            if (recorder.CaptureState != CaptureState.Stopped) recorder.StopRecording();
            FlushAtFence(cutoffTicks, endingEpoch);
            lock (gate)
            {
                generation = fence.Generation;
                health = "failed";
                message = reason;
                peak = 0;
            }
        }
    }

    public TrackStatus Status(long nowTicks)
    {
        lock (gate)
        {
            var currentHealth = health;
            var currentMessage = message;
            if (persist && packetProcessor.PendingFrames > 0 &&
                nowTicks - Math.Max(packetProcessor.LastWriteTicks, lastHeartbeatTicks) > TimelineClock.Frequency * 2)
            {
                currentHealth = "failed";
                currentMessage = "Local audio writes have stalled.";
            }
            else if (recorder.CaptureState == CaptureState.Capturing &&
                nowTicks - lastHeartbeatTicks > TimelineClock.Frequency * 2)
            {
                currentHealth = Kind == "render" ? "healthy-idle" : "unknown";
                currentMessage = Kind == "render"
                    ? "Endpoint is active but has not emitted packets. Silence is inferred."
                    : "Capture thread has not emitted a heartbeat.";
            }
            return new TrackStatus(
                TrackId, Name, Kind, currentHealth, peak, sampleCount, droppedFrames,
                lastHeartbeatTicks, packetProcessor.LastWriteTicks, DefaultRoles, currentMessage);
        }
    }

    public void Stop(long cutoffTicks)
    {
        long endingEpoch;
        lock (fence.SyncRoot)
        lock (gate)
        {
            persist = false;
            endingEpoch = persistenceEpoch;
        }

        if (recorder.CaptureState != CaptureState.Stopped) recorder.StopRecording();
        FlushAtFence(cutoffTicks, endingEpoch);
        lock (gate) generation = fence.Generation;
    }

    private void OnDataAvailable(ReadOnlySpan<byte> buffer, AudioClientBufferFlags flags, long devicePosition, long qpcPosition)
    {
        lock (fence.SyncRoot)
        {
            byte[]? copy = null;
            AudioPacket? packet = null;
            lock (gate)
            {
                if (disposed || retired) return;
                persist = fence.PersistAll && (Kind != "microphone" || fence.PersistMicrophone);
                var callbackTicks = clock.NowTicks;
                lastHeartbeatTicks = callbackTicks;
                var frames = buffer.Length / Format.BlockAlign;
                var alignedBytes = frames * Format.BlockAlign;
                if (alignedBytes != buffer.Length)
                {
                    dataLossDetected = true;
                    health = "failed";
                    message = "Capture endpoint emitted a malformed audio packet.";
                }
                // A TimestampError invalidates BOTH of WASAPI's position outputs, so a
                // device position reported alongside it must not be compared, advanced,
                // or persisted. Treat the running position as unknown for this packet.
                var positionTrusted = !flags.HasFlag(AudioClientBufferFlags.TimestampError);
                if (flags.HasFlag(AudioClientBufferFlags.DataDiscontinuity))
                {
                    // The flag alone means samples were lost, whether or not a prior
                    // position exists. Only derive a frame count from a trustworthy,
                    // monotonic position; otherwise record the loss without inventing one.
                    if (positionTrusted && expectedDevicePosition is long expected && devicePosition > expected)
                        droppedFrames += devicePosition - expected;
                    dataLossDetected = true;
                    health = "failed";
                    message = "Capture endpoint reported an audio discontinuity.";
                }
                expectedDevicePosition = positionTrusted ? checked(devicePosition + frames) : null;
                sampleCount += frames;

                if (!persist || frames == 0)
                {
                    peak = 0;
                    if (!dataLossDetected && !writerFailed) health = "healthy-idle";
                    return;
                }

                var hasValidTimestamp = qpcPosition > 0 && !flags.HasFlag(AudioClientBufferFlags.TimestampError);
                var packetStart = hasValidTimestamp ? clock.FromQpc100Nanoseconds(qpcPosition) : callbackTicks;
                if (!hasValidTimestamp) qpcPosition = 0;
                var skipFrames = FramesStrictlyBefore(
                    packetStart,
                    minimumPersistenceTicks,
                    frames,
                    Format.SampleRate);
                if (skipFrames >= frames) return;
                if (skipFrames > 0)
                {
                    buffer = buffer[(skipFrames * Format.BlockAlign)..alignedBytes];
                    devicePosition += skipFrames;
                    if (qpcPosition > 0) qpcPosition += TimelineClock.Scale(skipFrames, 10_000_000L, Format.SampleRate);
                    packetStart += TimelineClock.DurationForFrames(skipFrames, Format.SampleRate);
                    frames -= skipFrames;
                    alignedBytes = frames * Format.BlockAlign;
                }

                peak = flags.HasFlag(AudioClientBufferFlags.Silent) ? 0 : PeakMeter.Measure(buffer[..alignedBytes], Format);
                if (!dataLossDetected && !writerFailed)
                {
                    health = peak > 0.0001 ? "capturing-signal" : "acquired-silence";
                    message = null;
                }
                // Digital silence is never written to disk. peak == 0 means every sample
                // is exactly zero (a silent loopback endpoint or a muted source); the gap
                // is reconstructed as silence at render time from segment timestamps. This
                // is what stops idle playback devices writing gigabytes of blank audio.
                // A live microphone's noise floor and any playing audio are never exactly
                // zero, so real speech is always captured.
                if (peak == 0) return;
                copy = buffer[..alignedBytes].ToArray();
                packet = new AudioPacket(copy, devicePosition, qpcPosition, packetStart, generation, persistenceEpoch);
            }

            if (packet is not null && packetProcessor.TryEnqueue(packet)) return;

            if (copy is not null)
            {
                lock (gate)
                {
                    droppedFrames += copy.Length / Format.BlockAlign;
                    dataLossDetected = true;
                    health = "failed";
                    message = "Capture buffer overflowed because local audio writes were too slow.";
                }
            }
        }
    }

    internal static int FramesStrictlyBefore(
        long startTicks,
        long cutoffTicks,
        int totalFrames,
        int sampleRate)
    {
        if (cutoffTicks <= startTicks || totalFrames <= 0) return 0;
        return (int)Math.Min(
            totalFrames,
            TimelineClock.FramesBefore(startTicks, cutoffTicks, sampleRate));
    }

    private void FlushAtFence(long cutoffTicks, long endingEpoch)
    {
        if (writerFailed) return;
        packetProcessor.Flush(cutoffTicks, endingEpoch);
    }

    private void RecordWriterFailure(Exception error, long lostFrames)
    {
        writerFailed = true;
        lock (gate)
        {
            droppedFrames += lostFrames;
            health = "failed";
            message = error.Message;
        }
        _ = Task.Run(() =>
        {
            try { onFailure(this, error); }
            catch { }
        });
    }

    private void OnRecordingStopped(object? sender, StoppedEventArgs eventArgs)
    {
        if (eventArgs.Exception is null) return;
        lock (gate)
        {
            if (disposed) return;
            health = "failed";
            message = eventArgs.Exception.Message;
        }
        _ = Task.Run(() => onFailure(this, eventArgs.Exception));
    }

    private static TrackFormat FormatInfo(WaveFormat format)
    {
        var extensible = format as WaveFormatExtensible;
        return new TrackFormat(
            format.SampleRate,
            format.Channels,
            format.BitsPerSample,
            format.BlockAlign,
            format.AverageBytesPerSecond,
            format.Encoding.ToString().ToLowerInvariant(),
            extensible?.ValidBitsPerSample,
            extensible?.ChannelMask,
            extensible?.SubFormat.ToString());
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(disposed, this);

    public void Dispose()
    {
        lock (fence.SyncRoot)
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            persist = false;
        }

        recorder.DataAvailable -= OnDataAvailable;
        recorder.RecordingStopped -= OnRecordingStopped;
        try
        {
            if (recorder.CaptureState != CaptureState.Stopped) recorder.StopRecording();
        }
        catch { }
        packetProcessor.Dispose();
        recorder.Dispose();
        device.Dispose();
    }

}

internal static class WasapiRecorderBuilderExtensions
{
    public static WasapiRecorderBuilder ApplyLoopback(this WasapiRecorderBuilder builder, bool loopback) =>
        loopback ? builder.WithLoopbackCapture() : builder;
}
