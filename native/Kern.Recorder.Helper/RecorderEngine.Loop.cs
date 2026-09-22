namespace Kern.Recorder.Helper;

// The session timer: commits audio, flushes, reopens failed sources, follows devices, watches
// disk space, and publishes status. Everything here runs off the capture threads.
internal sealed partial class RecorderEngine
{
    private const long LowDiskStopBytes = 64L * 1024 * 1024;
    private static readonly TimeSpan TickPeriod = TimeSpan.FromMilliseconds(100);
    private static readonly long StatusInterval = TimelineClock.Frequency / 2;
    private static readonly long SessionWriteInterval = TimelineClock.Frequency * 5;
    private static readonly long HousekeepingInterval = TimelineClock.Frequency * 2;

    internal void Tick()
    {
        CallSession? active;
        lock (gate) active = session is { IsActive: true } current ? current : null;
        if (active is null) return;

        // The disk write happens outside the engine lock so a slow disk delays only this timer,
        // never a command, and never a capture thread (they only take the mixer lock).
        try { active.Commit.Pump(active.Clock.FrameAt(clock.NowTicks)); }
        catch (Exception error)
        {
            Interrupt(active, new CaptureFailure("write-failed", $"Audio could not be written: {error.Message}"));
            return;
        }

        RecorderStatus? status = null;
        lock (gate)
        {
            if (!ReferenceEquals(session, active) || !active.IsActive) return;
            var now = clock.NowTicks;
            var changed = active.Sources.Maintain(now);
            var housekeeping = now >= active.NextHousekeepingTicks;
            if (housekeeping) active.NextHousekeepingTicks = now + HousekeepingInterval;
            if (active.PlaybackMode == CallSession.DevicesMode && (Interlocked.Exchange(ref devicesChanged, 0) == 1 || housekeeping))
                changed |= ReconcileEndpoints(active, now);
            if (housekeeping && IsLowOnDisk(active))
                status = EndLocked(active, "interrupted", new CaptureFailure("low-storage",
                    "Recording stopped because the disk is almost full. Audio up to this point is saved."));
            else
            {
                if (changed || now >= active.NextSessionWriteTicks) WriteSessionLocked(active, now);
                if (changed || now >= active.NextStatusTicks)
                {
                    active.NextStatusTicks = now + StatusInterval;
                    status = active.Status(now);
                }
            }
        }
        if (status is not null) StatusChanged?.Invoke(this, status);
    }

    private void Interrupt(CallSession active, CaptureFailure failure)
    {
        RecorderStatus status;
        lock (gate)
        {
            if (!ReferenceEquals(session, active) || !active.IsActive) return;
            status = EndLocked(active, "interrupted", failure);
        }
        StatusChanged?.Invoke(this, status);
    }

    // Stop, low disk and write failure all end here: commit through the stop instant, record
    // the outcome in session.json, then release the devices. The audio already in audio.pcm
    // stays valid whatever happens to the final write.
    private RecorderStatus EndLocked(CallSession active, string state, CaptureFailure? failure)
    {
        var now = clock.NowTicks;
        var stopFrame = active.Clock.FrameAt(now);
        try { active.Commit.Finish(stopFrame); }
        catch (Exception error)
        {
            state = "interrupted";
            failure ??= new CaptureFailure("write-failed", $"Audio could not be written: {error.Message}");
        }
        active.End(state, failure, stopFrame, now);
        WriteSessionLocked(active, now);
        var status = active.Status(now);
        active.Dispose();
        StopLoop();
        return status;
    }

    // session.json is a description of audio.pcm, not the audio itself: a replace blocked by a
    // scanner is surfaced as a warning and retried on the next write, never ends the recording.
    private void WriteSessionLocked(CallSession active, long now)
    {
        active.NextSessionWriteTicks = now + SessionWriteInterval;
        try
        {
            active.Commit.WriteSession(active.Document(Producer, now));
            active.SessionFileFailing = false;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            active.SessionFileFailing = true;
        }
    }

    private bool IsLowOnDisk(CallSession active)
    {
        try { return options.FreeSpace(active.Path) < LowDiskStopBytes; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { return false; }
    }

    private void StartLoop()
    {
        StopLoop();
        if (!options.RunLoop) return;
        var cancellation = new CancellationTokenSource();
        loopCancellation = cancellation;
        _ = Task.Run(() => RunLoopAsync(cancellation.Token), CancellationToken.None);
    }

    // Cancelled, not disposed: the loop may be mid-tick (a low-disk stop ends the session from
    // inside Tick) and still reads the token afterwards. It holds no timer, so nothing leaks.
    private void StopLoop()
    {
        loopCancellation?.Cancel();
        loopCancellation = null;
    }

    private async Task RunLoopAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TickPeriod);
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
            {
                // One bad tick (a COM hiccup enumerating devices) must not stop audio commits.
                try { Tick(); }
                catch (Exception error) when (error is not OutOfMemoryException) { }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }
}
