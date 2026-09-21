using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal sealed class CaptureTrack : ICaptureTrack
{
    // ~5 s of 10 ms packets: enough to ride out a bounded metadata replace retry
    // on the writer thread without overflowing and dropping frames.
    private const int CaptureQueueCapacity = 512;
    private readonly object gate = new();
    private readonly string sessionPath;
    private readonly TimelineClock clock;
    private readonly int segmentDurationMs;
    private readonly Action<SegmentManifest> onSegmentFinalised;
    private readonly Action<ICaptureTrack, Exception> onFailure;
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
    private string? historicalLoss;
    private volatile bool writerFailed;
    private long sampleCount;
    private long droppedFrames;
    private long lastHeartbeatTicks;
    private long? expectedDevicePosition;
    private long consecutiveSilentFrames;
    private long continuityId;
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
        Action<ICaptureTrack, Exception> onFailure)
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
            RecordWriterFailure,
            onPacketOmitted: RecordTimingOmission);
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
    public bool HasWriterFailure => writerFailed;

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
            persist = fence.PersistAll && (Kind != "microphone" || fence.PersistMicrophone);
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
                if (!writerFailed) health = "healthy-idle";
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
            if (!writerFailed) health = "healthy-idle";
            if (!writerFailed) message = null;
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
                if (!writerFailed) health = "healthy-idle";
                if (!writerFailed) message = enabled ? null : reason;
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
            try { if (recorder.CaptureState != CaptureState.Stopped) recorder.StopRecording(); }
            catch { /* Device invalidation can reject StopRecording; the detached callback is already fenced. */ }
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
            var currentMessage = message ?? historicalLoss;
            if (!retired && persist && packetProcessor.PendingFrames > 0 &&
                nowTicks - Math.Max(packetProcessor.LastWriteTicks, lastHeartbeatTicks) > TimelineClock.Frequency * 2)
            {
                currentHealth = "failed";
                currentMessage = "Local audio writes have stalled.";
            }
            else if (!retired && recorder.CaptureState == CaptureState.Capturing &&
                nowTicks - lastHeartbeatTicks > TimelineClock.Frequency * 2)
            {
                currentHealth = Kind == "render" ? "healthy-idle" : "unknown";
                currentMessage = Kind == "render"
                    ? "Endpoint is active but has not emitted packets. Silence is inferred."
                    : "Capture thread has not emitted a heartbeat.";
            }
            return new TrackStatus(
                TrackId, Name, Kind, currentHealth, peak, sampleCount, droppedFrames,
                lastHeartbeatTicks, packetProcessor.LastWriteTicks, DefaultRoles, currentMessage, retired);
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
                // A fatal storage failure must stay visible until the engine retires
                // this track, even if additional WASAPI callbacks arrive first.
                if (writerFailed) return;
                var frames = buffer.Length / Format.BlockAlign;
                var alignedBytes = frames * Format.BlockAlign;
                if (alignedBytes != buffer.Length)
                {
                    droppedFrames += frames;
                    historicalLoss = "Some audio was omitted: endpoint emitted a malformed packet.";
                    health = "unknown";
                    message = historicalLoss;
                    continuityId++;
                    expectedDevicePosition = null;
                    return;
                }
                // WASAPI's TimestampError marks the QPC value as uncertain. The device
                // position is still the stream's frame counter, so continuity holds;
                // only the clock anchor for a new run is affected (see below).
                var positionTrusted = devicePosition >= 0 && devicePosition <= long.MaxValue - frames;
                var discontinuity = flags.HasFlag(AudioClientBufferFlags.DataDiscontinuity);
                if (!positionTrusted || discontinuity) continuityId++;
                if (discontinuity)
                {
                    // WASAPI flags stream transitions as well as glitches. Count only
                    // a measured forward gap; do not claim every flag lost samples.
                    if (positionTrusted && expectedDevicePosition is long expected && devicePosition > expected)
                    {
                        droppedFrames += devicePosition - expected;
                        historicalLoss = "Some audio is missing: endpoint skipped audio frames.";
                        message = historicalLoss;
                    }
                    else
                    {
                        message = "Capture endpoint reported a timing discontinuity; a new audio run was started.";
                    }
                }
                expectedDevicePosition = positionTrusted ? devicePosition + frames : null;
                sampleCount += frames;

                if (!persist || frames == 0)
                {
                    peak = 0;
                    if (!writerFailed) health = "healthy-idle";
                    return;
                }

                // Audio is never dropped for clock trouble. An untrusted or unconvertible
                // QPC value anchors the packet at its arrival instead; Bluetooth endpoints
                // in particular flag TimestampError for long stretches while the frames
                // themselves are perfectly good.
                var timestampTrusted = !flags.HasFlag(AudioClientBufferFlags.TimestampError) && qpcPosition > 0;
                var packetStart = callbackTicks - TimelineClock.DurationForFrames(frames, Format.SampleRate);
                if (timestampTrusted)
                {
                    try { packetStart = clock.FromQpc100Nanoseconds(qpcPosition); }
                    catch (Exception error) when (error is OverflowException or ArgumentOutOfRangeException)
                    {
                        timestampTrusted = false;
                    }
                }
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
                if (!writerFailed)
                {
                    health = peak > 0.0001 ? "capturing-signal" : "acquired-silence";
                    if (!discontinuity) message = null;
                }
                // Drop only SUSTAINED digital silence so idle playback endpoints stop
                // writing gigabytes of blank audio, WITHOUT fragmenting active audio.
                // Short pauses (< 1s) are kept so a talking track stays one continuous
                // segment; once silence runs past 1s (an idle endpoint or a long gap) we
                // stop persisting, and the gap is reconstructed as silence at render time.
                if (peak == 0)
                {
                    consecutiveSilentFrames += frames;
                    if (consecutiveSilentFrames > Format.SampleRate) return;
                }
                else consecutiveSilentFrames = 0;
                copy = buffer[..alignedBytes].ToArray();
                packet = new AudioPacket(copy, devicePosition, qpcPosition, packetStart, generation, persistenceEpoch,
                    PositionTrusted: positionTrusted, Discontinuity: discontinuity,
                    ContinuityId: continuityId, ObservedAtTicks: callbackTicks,
                    MinimumStartTicks: minimumPersistenceTicks, TimestampTrusted: timestampTrusted);
            }

            if (packet is not null && packetProcessor.TryEnqueue(packet)) return;

            if (copy is not null)
            {
                lock (gate)
                {
                    droppedFrames += copy.Length / Format.BlockAlign;
                    historicalLoss = "Some audio is missing: capture buffer overflowed while writes were slow.";
                    health = "unknown";
                    message = historicalLoss;
                    continuityId++;
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

    private void RecordTimingOmission(long frames)
    {
        lock (gate)
        {
            droppedFrames += frames;
            historicalLoss = "Some audio was omitted because its timestamp was unavailable or inconsistent.";
            if (!writerFailed) { health = "unknown"; message = historicalLoss; }
        }
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
