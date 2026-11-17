using System.ComponentModel;
using System.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;

namespace Kern.Recorder.Helper;

// One process holding a capture (microphone) audio session in the Active state.
internal readonly record struct MicSession(int Pid, string Name);

internal interface IMicEndpoint : IDisposable
{
    IReadOnlyList<MicSession> ActiveSessions();
}

internal interface IMicSessionSource
{
    // Every capture endpoint Windows knows about. Throws when the list itself cannot be read.
    IReadOnlyList<IMicEndpoint> Endpoints();
}

// Same technique as fastrepl/anarlog (MIT), crates/detect/src/list/windows.rs: walk the capture
// endpoints, list their IAudioSessionManager2 sessions, keep the ones in state Active, map the
// owning PID to a process name. Sessions are live per-PID state, so no registry parsing is needed.
internal sealed class WasapiMicSessionSource : IMicSessionSource, IDisposable
{
    private readonly MMDeviceEnumerator enumerator = new();

    public IReadOnlyList<IMicEndpoint> Endpoints()
    {
        using var collection = enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active);
        var endpoints = new List<IMicEndpoint>(collection.Count);
        for (var i = 0; i < collection.Count; i++) endpoints.Add(new WasapiMicEndpoint(collection[i]));
        return endpoints;
    }

    public void Dispose() => enumerator.Dispose();
}

internal sealed class WasapiMicEndpoint(MMDevice device) : IMicEndpoint
{
    public IReadOnlyList<MicSession> ActiveSessions()
    {
        var manager = device.AudioSessionManager;
        manager.RefreshSessions();
        var sessions = manager.Sessions;
        var result = new List<MicSession>();
        for (var i = 0; i < sessions.Count; i++)
        {
            using var session = sessions[i];
            if (session.State != AudioSessionState.AudioSessionStateActive) continue;
            var pid = (int)session.GetProcessID;
            if (pid <= 0) continue;
            var name = ProcessName(pid);
            if (name is not null) result.Add(new MicSession(pid, name));
        }
        return result;
    }

    // Lower-case, no ".exe". A process that exited between the enumeration and the lookup is skipped.
    private static string? ProcessName(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName.ToLowerInvariant();
        }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return null;
        }
    }

    public void Dispose() => device.Dispose();
}
