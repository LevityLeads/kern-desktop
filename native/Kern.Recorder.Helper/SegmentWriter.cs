using System.Security.Cryptography;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal interface ISegmentWriter : IDisposable
{
    long TimelineStartTicks { get; }
    string? MetadataPath { get; }
    long TimelineEndTicks { get; }
    long SampleCount { get; }
    void Write(ReadOnlySpan<byte> buffer, long devicePosition, long qpcPosition, long packetStartTicks);
    SegmentManifest Finalise(long timelineEndTicks);
}

internal sealed record SegmentWriterOptions(
    string SessionPath,
    string TrackId,
    WaveFormat Format,
    long Generation,
    int Sequence,
    long TimelineStartTicks);

internal sealed class SegmentWriter : ISegmentWriter
{
    private readonly string sessionPath;
    private readonly string trackId;
    private readonly WaveFormat format;
    private readonly long generation;
    private readonly int sequence;
    private readonly string segmentId = Guid.NewGuid().ToString("N");
    private readonly string partialPath;
    private readonly string finalPath;
    private readonly string metadataPath;
    private readonly FileStream stream;
    private readonly WaveFileWriter writer;
    private bool closed;
    private long? firstDevicePosition;
    private long? firstQpcPosition;
    private long? lastDevicePosition;
    private long? lastQpcPosition;
    private long timelineEndTicks;

    public SegmentWriter(SegmentWriterOptions options)
        : this(
            options.SessionPath,
            options.TrackId,
            options.Format,
            options.Generation,
            options.Sequence,
            options.TimelineStartTicks)
    {
    }

    public SegmentWriter(
        string sessionPath,
        string trackId,
        WaveFormat format,
        long generation,
        int sequence,
        long timelineStartTicks)
    {
        this.sessionPath = sessionPath;
        this.trackId = trackId;
        this.format = format;
        this.generation = generation;
        this.sequence = sequence;
        TimelineStartTicks = timelineStartTicks;
        timelineEndTicks = timelineStartTicks;
        var trackDirectory = Path.Combine(sessionPath, "segments", trackId);
        Directory.CreateDirectory(trackDirectory);
        partialPath = Path.Combine(trackDirectory, $"{sequence:D6}-{segmentId}.wav.partial");
        finalPath = Path.Combine(trackDirectory, $"{sequence:D6}-{segmentId}.wav");
        metadataPath = finalPath + ".metadata.json";
        stream = new FileStream(partialPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 64 * 1024, FileOptions.WriteThrough);
        writer = new WaveFileWriter(stream, format);
    }

    public long TimelineStartTicks { get; }
    public string MetadataPath => metadataPath;
    public long TimelineEndTicks => timelineEndTicks;
    public long BytesWritten => writer.Length;
    public long SampleCount => writer.Length / format.BlockAlign;

    public void Write(
        ReadOnlySpan<byte> buffer,
        long devicePosition,
        long qpcPosition,
        long packetStartTicks)
    {
        ObjectDisposedException.ThrowIf(closed, this);
        if (buffer.Length == 0 || buffer.Length % format.BlockAlign != 0)
            throw new InvalidDataException("Audio buffer is empty or not frame aligned.");
        firstDevicePosition ??= devicePosition;
        firstQpcPosition ??= qpcPosition;
        lastDevicePosition = checked(devicePosition + buffer.Length / format.BlockAlign - 1);
        lastQpcPosition = qpcPosition > 0
            ? checked(qpcPosition + TimelineClock.Scale(
                buffer.Length / format.BlockAlign - 1L,
                10_000_000L,
                format.SampleRate))
            : 0;
        writer.Write(buffer);
        var frames = buffer.Length / format.BlockAlign;
        timelineEndTicks = checked(packetStartTicks + TimelineClock.DurationForFrames(frames, format.SampleRate));
    }

    public SegmentManifest Finalise(long timelineEndTicks)
    {
        ObjectDisposedException.ThrowIf(closed, this);
        closed = true;
        var audioBytes = writer.Length;
        var sampleCount = audioBytes / format.BlockAlign;
        writer.Dispose();
        stream.Flush(flushToDisk: true);
        stream.Dispose();
        WavValidator.Validate(partialPath, audioBytes);

        var bytes = new FileInfo(partialPath).Length;
        string checksum;
        using (var checksumStream = File.OpenRead(partialPath))
            checksum = Convert.ToHexString(SHA256.HashData(checksumStream)).ToLowerInvariant();
        var manifest = new SegmentManifest
        {
            SegmentId = segmentId,
            TrackId = trackId,
            Sequence = sequence,
            RelativePath = Path.GetRelativePath(sessionPath, finalPath).Replace(Path.DirectorySeparatorChar, '/'),
            Status = "finalised",
            Generation = generation,
            TimelineStartTicks = TimelineStartTicks,
            TimelineEndTicks = timelineEndTicks,
            SampleCount = sampleCount,
            ByteLength = bytes,
            Sha256 = checksum,
            FirstDevicePosition = firstDevicePosition,
            FirstQpcPosition = firstQpcPosition,
            LastDevicePosition = lastDevicePosition,
            LastQpcPosition = lastQpcPosition,
            PublishedAtUtc = DateTimeOffset.UtcNow.ToString("O"),
        };

        // Metadata becomes durable before the WAV is published, so recovery never invents timing data.
        AtomicFile.WriteJson(metadataPath, manifest);
        AtomicFile.Publish(partialPath, finalPath);
        return manifest;
    }

    public void Dispose()
    {
        if (closed) return;
        closed = true;
        writer.Dispose();
        stream.Dispose();
    }
}
