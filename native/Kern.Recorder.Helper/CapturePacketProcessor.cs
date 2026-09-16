using System.Threading.Channels;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal sealed class CapturePacketProcessor : IDisposable
{
    private readonly object gate = new();
    private readonly string sessionPath;
    private readonly string trackId;
    private readonly WaveFormat format;
    private readonly long targetFrames;
    private readonly TimelineClock clock;
    private readonly Action<SegmentManifest> onSegmentFinalised;
    private readonly Action<Exception, long> onFailure;
    private readonly Func<SegmentWriterOptions, ISegmentWriter> createWriter;
    private readonly Channel<object> workItems;
    private readonly Task writerTask;
    private readonly SemaphoreSlim enqueueGate = new(1, 1);
    private ISegmentWriter? writer;
    private AudioPacket? pendingPacket;
    private long? writerPersistenceEpoch;
    private int nextSequence;
    private long pendingFrames;
    private long lastWriteTicks;
    private bool writerFailed;
    private bool disposed;

    public CapturePacketProcessor(
        string sessionPath,
        string trackId,
        WaveFormat format,
        int segmentDurationMs,
        int queueCapacity,
        TimelineClock clock,
        Action<SegmentManifest> onSegmentFinalised,
        Action<Exception, long> onFailure,
        Func<SegmentWriterOptions, ISegmentWriter>? createWriter = null)
    {
        this.sessionPath = sessionPath;
        this.trackId = trackId;
        this.format = format;
        this.clock = clock;
        this.onSegmentFinalised = onSegmentFinalised;
        this.onFailure = onFailure;
        this.createWriter = createWriter ?? (options => new SegmentWriter(options));
        targetFrames = Math.Max(1L, (long)format.SampleRate * segmentDurationMs / 1000);
        workItems = Channel.CreateBounded<object>(new BoundedChannelOptions(queueCapacity)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait,
        });
        writerTask = Task.Run(ProcessWorkItemsAsync);
    }

    public long PendingFrames
    {
        get { lock (gate) return pendingFrames; }
    }

    public long LastWriteTicks
    {
        get { lock (gate) return lastWriteTicks; }
    }

    public bool TryEnqueue(AudioPacket packet)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        if (!enqueueGate.Wait(0)) return false;
        try
        {
            if (!workItems.Writer.TryWrite(packet)) return false;
            lock (gate) pendingFrames += packet.FrameCount(format.BlockAlign);
            return true;
        }
        finally { enqueueGate.Release(); }
    }

    public void Flush(long cutoffTicks, long persistenceEpoch)
    {
        if (writerFailed) return;
        enqueueGate.Wait();
        try
        {
            var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            workItems.Writer.WriteAsync(new FlushRequest(cutoffTicks, persistenceEpoch, completion))
                .AsTask().GetAwaiter().GetResult();
            completion.Task.GetAwaiter().GetResult();
        }
        finally { enqueueGate.Release(); }
    }

    private async Task ProcessWorkItemsAsync()
    {
        await foreach (var item in workItems.Reader.ReadAllAsync().ConfigureAwait(false))
        {
            switch (item)
            {
                case AudioPacket packet:
                    ProcessQueuedPacket(packet);
                    break;
                case FlushRequest flush:
                    ProcessFlush(flush);
                    break;
            }
        }

        writer?.Dispose();
        writer = null;
        writerPersistenceEpoch = null;
    }

    private void ProcessQueuedPacket(AudioPacket packet)
    {
        if (writerFailed)
        {
            RemovePending(packet);
            return;
        }
        try
        {
            if (pendingPacket is not null)
            {
                ProcessPacket(pendingPacket);
                RemovePending(pendingPacket);
            }
            pendingPacket = packet;
        }
        catch (Exception error)
        {
            var lostFrames = pendingPacket?.FrameCount(format.BlockAlign) ?? 0;
            if (pendingPacket is not null) RemovePending(pendingPacket);
            pendingPacket = null;
            RecordWriterFailure(error, lostFrames + packet.FrameCount(format.BlockAlign));
        }
    }

    private void ProcessFlush(FlushRequest flush)
    {
        try
        {
            if (!writerFailed)
            {
                ProcessFencePacket(pendingPacket, flush);
                if (pendingPacket is not null) RemovePending(pendingPacket);
                pendingPacket = null;
                FinaliseWriter(flush.CutoffTicks);
            }
            flush.Completion.TrySetResult();
        }
        catch (Exception error)
        {
            var lostFrames = pendingPacket?.FrameCount(format.BlockAlign) ?? 0;
            if (pendingPacket is not null) RemovePending(pendingPacket);
            pendingPacket = null;
            RecordWriterFailure(error, lostFrames);
            flush.Completion.TrySetException(error);
        }
    }

    private void ProcessFencePacket(AudioPacket? packet, FlushRequest flush)
    {
        if (packet is null) return;
        if (packet.PersistenceEpoch != flush.PersistenceEpoch)
        {
            ProcessPacket(packet);
            return;
        }
        var permittedFrames = CaptureTrack.FramesStrictlyBefore(
            packet.TimelineStartTicks,
            flush.CutoffTicks,
            packet.FrameCount(format.BlockAlign),
            format.SampleRate);
        if (permittedFrames <= 0) return;
        ProcessPacket(packet with
        {
            Data = packet.Data[..checked(permittedFrames * format.BlockAlign)],
        });
    }

    private void ProcessPacket(AudioPacket packet)
    {
        var frames = packet.FrameCount(format.BlockAlign);
        if (frames == 0) return;
        if (writer is not null && writerPersistenceEpoch != packet.PersistenceEpoch)
            FinaliseWriter(packet.TimelineStartTicks);
        // Never concatenate a missing interval or a backward/reset timestamp into
        // one apparently continuous WAV. Permit only one source frame of QPC rounding.
        if (writer is not null && Math.Abs((decimal)packet.TimelineStartTicks - writer.TimelineEndTicks) >
            Math.Max(1, TimelineClock.DurationForFrames(1, format.SampleRate)))
            FinaliseWriter(writer.TimelineEndTicks);
        var offsetFrames = 0;
        while (offsetFrames < frames)
        {
            var offsetTicks = TimelineClock.DurationForFrames(offsetFrames, format.SampleRate);
            if (writer is null)
            {
                writer = createWriter(new SegmentWriterOptions(
                    sessionPath,
                    trackId,
                    format,
                    packet.Generation,
                    nextSequence++,
                    packet.TimelineStartTicks + offsetTicks));
                writerPersistenceEpoch = packet.PersistenceEpoch;
            }
            if (writerPersistenceEpoch != packet.PersistenceEpoch)
                throw new InvalidOperationException("Capture persistence epochs reached the writer out of order.");
            var availableInSegment = targetFrames - writer.SampleCount;
            var writeFrames = (int)Math.Min(frames - offsetFrames, availableInSegment);
            var bytes = writeFrames * format.BlockAlign;
            var offsetBytes = offsetFrames * format.BlockAlign;
            var packetDevicePosition = packet.DevicePosition + offsetFrames;
            var packetQpcPosition = packet.QpcPosition > 0
                ? packet.QpcPosition + TimelineClock.Scale(offsetFrames, 10_000_000L, format.SampleRate)
                : 0;
            writer.Write(
                packet.Data.AsSpan(offsetBytes, bytes),
                packetDevicePosition,
                packetQpcPosition,
                packet.TimelineStartTicks + offsetTicks);
            offsetFrames += writeFrames;
            if (writer.SampleCount >= targetFrames)
            {
                var segmentEnd = packet.TimelineStartTicks +
                    TimelineClock.DurationForFrames(offsetFrames, format.SampleRate);
                FinaliseWriter(segmentEnd);
            }
        }
    }

    private void FinaliseWriter(long cutoffTicks)
    {
        if (writer is null) return;
        var finalising = writer;
        writer = null;
        writerPersistenceEpoch = null;
        var timelineEndTicks = Math.Min(cutoffTicks, finalising.TimelineEndTicks);
        if (timelineEndTicks < finalising.TimelineStartTicks)
            timelineEndTicks = finalising.TimelineStartTicks;
        if (finalising.SampleCount == 0)
        {
            finalising.Dispose();
            return;
        }
        onSegmentFinalised(finalising.Finalise(timelineEndTicks));
        if (finalising.MetadataPath is not null) AtomicFile.DeleteBestEffort(finalising.MetadataPath);
        lock (gate) lastWriteTicks = clock.NowTicks;
    }

    private void RemovePending(AudioPacket packet)
    {
        lock (gate)
            pendingFrames = Math.Max(0, pendingFrames - packet.FrameCount(format.BlockAlign));
    }

    private void RecordWriterFailure(Exception error, long lostFrames)
    {
        writerFailed = true;
        writer?.Dispose();
        writer = null;
        writerPersistenceEpoch = null;
        lock (gate)
        {
            lostFrames = Math.Max(lostFrames, pendingFrames);
            pendingFrames = 0;
        }
        onFailure(error, lostFrames);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        workItems.Writer.TryComplete();
        try { writerTask.GetAwaiter().GetResult(); }
        catch { }
        enqueueGate.Dispose();
    }

    private sealed record FlushRequest(
        long CutoffTicks,
        long PersistenceEpoch,
        TaskCompletionSource Completion);
}

internal sealed record AudioPacket(
    byte[] Data,
    long DevicePosition,
    long QpcPosition,
    long TimelineStartTicks,
    long Generation,
    long PersistenceEpoch)
{
    public int FrameCount(int blockAlign) => Data.Length / blockAlign;
}
