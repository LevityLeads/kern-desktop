namespace Kern.Recorder.Helper;

// All recovery runs under the engine gate, on the cancellable health loop. There
// is no detached reopen task that can create a track after Stop/Dispose.
internal sealed partial class RecorderEngine
{
    private string? pinnedMicrophoneId;
    private bool devicesChanged;
    private readonly Dictionary<string, RecoveryAttempt> recovery = [];
    private readonly HashSet<string> permanentlyFailed = [];
    private sealed class RecoveryAttempt
    {
        public int Attempts;
        public long NextTicks;
        public string? GapId;
        public long AcquireDeadline;
    }

    private void OnDevicesChanged(object? sender, EventArgs eventArgs)
    {
        lock (gate)
        {
            if (disposed || state is "idle" or "stopped" or "interrupted") return;
            devicesChanged = true;
        }
    }

    private void OnTrackFailure(ICaptureTrack track, Exception error)
    {
        lock (gate)
        {
            if (disposed || state is "idle" or "stopped" or "interrupted" ||
                !tracks.Contains(track) || track.IsRetired) return;
            if (track.HasWriterFailure) permanentlyFailed.Add(track.Kind);
            RetireTrack(track, clock.NowTicks, error.Message);
            if (state == "recording") state = "degraded";
            failure = new { code = "track-failed", trackId = track.TrackId,
                message = track.HasWriterFailure ? "Local audio storage failed. Stop recording and check disk access."
                    : $"{(track.Kind == "render" ? "Incoming audio" : "Microphone")} unavailable. Reconnecting the recording device." };
            try { PersistState(); }
            finally { StatusChanged?.Invoke(this, SnapshotUnsafe()); }
        }
    }

    private void RetireTrack(ICaptureTrack track, long cutoff, string reason)
    {
        if (track.IsRetired) return;
        try { track.RetireEndpoint(cutoff, reason); }
        catch (Exception error)
        {
            // A flush failure is storage trouble, not a reason to reopen the device.
            permanentlyFailed.Add(track.Kind);
            failure = new { code = "track-storage-failed", trackId = track.TrackId, message = error.Message };
        }
        finally { track.Dispose(); }
        if (!recovery.TryGetValue(track.Kind, out var attempt))
            recovery[track.Kind] = attempt = new RecoveryAttempt();
        attempt.GapId ??= store!.OpenGap(track.Kind, "endpoint-unavailable", cutoff, fence.Generation).GapId;
    }

    // Called by HealthLoop and directly by deterministic backend tests.
    internal void CheckRecovery()
    {
        lock (gate)
        {
            if (disposed || sessionCancellation?.IsCancellationRequested != false ||
                state is "idle" or "stopped" or "interrupted") return;
            try { ReconcileRecovery(); }
            catch (Exception error)
            {
                failure = new { code = "device-recovery-failed", message = error.Message };
                if (state == "recording") state = "degraded";
            }
        }
    }

    private void ReconcileRecovery()
    {
        var now = clock.NowTicks;
        // Poll desired endpoints only on a device notification or a recovery attempt.
        if (!devicesChanged && recovery.Count == 0 && tracks.Where(t => !t.IsRetired).All(t => t.IsCapturing)) return;
        if (devicesChanged)
        {
            foreach (var attempt in recovery.Values) { attempt.Attempts = 0; attempt.NextTicks = 0; }
            devicesChanged = false;
        }
        var renderIds = devices.DefaultRenderIds();
        var captureIds = devices.ActiveCaptureIds();
        foreach (var track in tracks.Where(t => !t.IsRetired).ToArray())
        {
            var active = track.Kind == "render" ? renderIds.Contains(track.EndpointId) : captureIds.Contains(track.EndpointId);
            if (!active || !track.IsCapturing)
                RetireTrack(track, now, "Recording endpoint is unavailable; some audio may be missing.");
            else track.UpdateDefaultRoles(devices.DefaultRoles(track.EndpointId, track.Kind));
        }
        EnsureTrack("render", renderIds.FirstOrDefault(), now);
        EnsureTrack("microphone", pinnedMicrophoneId is not null && captureIds.Contains(pinnedMicrophoneId) ? pinnedMicrophoneId : null, now);
        PersistState();
    }

    private void EnsureTrack(string kind, string? endpointId, long now)
    {
        var active = tracks.FirstOrDefault(t => !t.IsRetired && t.Kind == kind && t.IsCapturing);
        if (active is not null)
        {
            if (recovery.TryGetValue(kind, out var existing))
            {
                var status = active.Status(now);
                // StartRecording returning is not proof of acquisition. Close the gap
                // after a packet heartbeat, including valid acquired silence.
                if (status.SampleCount > 0 && status.Health is "capturing-signal" or "acquired-silence")
                {
                    if (existing.GapId is not null) store!.CloseGap(existing.GapId, status.LastHeartbeatTicks);
                    recovery.Remove(kind);
                    return;
                }
                // A restarted microphone must produce callbacks. Playback can be
                // legitimately silent with no WASAPI packets, so it is never reopened
                // merely for silence. Its recovery warning stays until acquisition.
                if (kind == "microphone" && fence.PersistAll && fence.PersistMicrophone &&
                    now >= existing.AcquireDeadline)
                    RetireTrack(active, now, "Reconnected microphone produced no audio callbacks.");
                else return;
            }
            else return;
        }
        if (!recovery.TryGetValue(kind, out var attempt))
        {
            recovery[kind] = attempt = new RecoveryAttempt();
            attempt.GapId = store!.OpenGap(kind, "endpoint-unavailable", now, fence.Generation).GapId;
        }
        if (permanentlyFailed.Contains(kind) || attempt.Attempts >= 6 || now < attempt.NextTicks) return;
        attempt.Attempts++;
        attempt.NextTicks = now + TimelineClock.Frequency * Math.Min(16, 1 << (attempt.Attempts - 1));
        if (endpointId is null) return;
        ICaptureTrack? added = null;
        try
        {
            added = AddTrack(endpointId, kind, activeSegmentDurationMs);
            added.Start();
            // The shared fence is authoritative even if replacement starts paused or muted.
            if (!fence.PersistAll) added.PauseAtFence(now);
            if (kind == "microphone" && !fence.PersistMicrophone)
                added.ApplyMicrophoneFence(false, now, "Kern microphone is muted.");
            attempt.AcquireDeadline = now + 2 * TimelineClock.Frequency;
        }
        catch (Exception error)
        {
            if (added is not null) RetireTrack(added, now, error.Message);
            failure = new { code = "endpoint-add-failed", message = "Recording device reconnect failed; audio is missing." };
        }
    }

    private bool HasActiveCaptureFailure(long now) => recovery.Count > 0 || permanentlyFailed.Count > 0 ||
        tracks.Where(t => !t.IsRetired).Any(t => t.Status(now).Health is "failed" or "unknown");

    private void CloseRecoveryGaps(long cutoff)
    {
        foreach (var attempt in recovery.Values)
            if (attempt.GapId is not null) store!.CloseGap(attempt.GapId, cutoff);
        recovery.Clear();
    }
}
