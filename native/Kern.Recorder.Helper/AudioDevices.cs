using System.Collections.Concurrent;
using NAudio.CoreAudioApi;

namespace Kern.Recorder.Helper;

internal sealed class AudioDevices : IDisposable
{
    private readonly MMDeviceEnumerator enumerator = new();
    private readonly MMDeviceNotificationClient notifications;
    private readonly ConcurrentQueue<string> changes = new();
    private Task? notificationTask;

    public AudioDevices()
    {
        notifications = enumerator.CreateNotificationClient(useSynchronizationContext: false);
        notifications.DeviceAdded += (_, eventArgs) => changes.Enqueue(eventArgs.DeviceId);
        notifications.DeviceRemoved += (_, eventArgs) => changes.Enqueue(eventArgs.DeviceId);
        notifications.DeviceStateChanged += (_, eventArgs) => changes.Enqueue(eventArgs.DeviceId);
        notifications.DefaultDeviceChanged += (_, eventArgs) => changes.Enqueue(eventArgs.DeviceId ?? string.Empty);
        notifications.PropertyValueChanged += (_, eventArgs) => changes.Enqueue(eventArgs.DeviceId);
    }

    public event EventHandler? Changed;

    public void StartNotifications(CancellationToken cancellationToken)
    {
        if (notificationTask is not null) throw new InvalidOperationException("Audio notifications have already started.");
        notificationTask = Task.Run(async () =>
        {
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    if (changes.TryDequeue(out _))
                    {
                        while (changes.TryDequeue(out _)) { }
                        Changed?.Invoke(this, EventArgs.Empty);
                    }
                    await Task.Delay(100, cancellationToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        }, cancellationToken);
    }

    public DeviceList List()
    {
        var defaults = GetDefaults();
        return new DeviceList(
            Enumerate(DataFlow.Render, defaults),
            Enumerate(DataFlow.Capture, defaults));
    }

    public IReadOnlyList<MMDevice> ActiveRenderDevices()
    {
        using var collection = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
        // Each collection index access returns a fresh disposable snapshot wrapper.
        // The snapshot is only used to read the endpoint ID; the caller-owned device
        // is opened separately via GetDevice, so the snapshot must be disposed here.
        var result = new List<MMDevice>();
        try
        {
            for (var i = 0; i < collection.Count; i++)
            {
                using var snapshot = collection[i];
                result.Add(enumerator.GetDevice(snapshot.ID));
            }
        }
        catch
        {
            foreach (var opened in result) opened.Dispose();
            throw;
        }
        return result;
    }

    // Only the default playback device (the multimedia default, i.e. what the user
    // actually hears) is captured, plus the microphone. Virtual and idle endpoints
    // (VB-Cable, Steam, Oculus, etc.) and the separate communications default are not
    // captured, keeping a call to two real tracks: you and the other side.
    public IReadOnlyList<MMDevice> DefaultRenderDevices()
    {
        var result = new List<MMDevice>();
        try
        {
            if (enumerator.TryGetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia, out var snapshot))
            {
                string id;
                using (snapshot) id = snapshot.ID;
                var device = enumerator.GetDevice(id);
                if (device.State == DeviceState.Active) result.Add(device);
                else device.Dispose();
            }
        }
        catch
        {
            foreach (var opened in result) opened.Dispose();
            throw;
        }
        return result;
    }

    public HashSet<string> DefaultRenderIds()
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (enumerator.TryGetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia, out var device))
            using (device) ids.Add(device.ID);
        return ids;
    }

    public HashSet<string> ActiveRenderIds() => ActiveEndpointIds(DataFlow.Render);

    public HashSet<string> ActiveCaptureIds() => ActiveEndpointIds(DataFlow.Capture);

    private HashSet<string> ActiveEndpointIds(DataFlow flow)
    {
        using var collection = enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < collection.Count; i++)
        {
            using var snapshot = collection[i];
            ids.Add(snapshot.ID);
        }
        return ids;
    }

    public MMDevice ResolveMicrophone(MicrophoneSelection selection)
    {
        try
        {
            if (selection.Mode == "default")
                return enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
            if (selection.Mode != "device" || string.IsNullOrWhiteSpace(selection.DeviceId))
                throw new ProtocolException("invalid-microphone", "Microphone selection is invalid.");
            var device = enumerator.GetDevice(selection.DeviceId);
            if (device.DataFlow != DataFlow.Capture || device.State != DeviceState.Active)
            {
                device.Dispose();
                throw new ProtocolException("microphone-unavailable", "Chosen microphone is not active.");
            }
            return device;
        }
        catch (ProtocolException) { throw; }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            throw new ProtocolException("microphone-unavailable", "Chosen microphone is unavailable.");
        }
    }

    public IReadOnlyList<string> DefaultRoles(string endpointId, DataFlow flow)
    {
        var defaults = GetDefaults();
        return defaults
            .Where(item => item.Flow == flow && string.Equals(item.DeviceId, endpointId, StringComparison.Ordinal))
            .Select(item => item.Role.ToString().ToLowerInvariant())
            .OrderBy(role => role, StringComparer.Ordinal)
            .ToList();
    }

    private List<(DataFlow Flow, Role Role, string DeviceId)> GetDefaults()
    {
        var result = new List<(DataFlow, Role, string)>();
        foreach (var flow in new[] { DataFlow.Render, DataFlow.Capture })
        foreach (var role in new[] { Role.Multimedia, Role.Communications })
        {
            if (enumerator.TryGetDefaultAudioEndpoint(flow, role, out var device))
            {
                using (device) result.Add((flow, role, device.ID));
            }
        }
        return result;
    }

    private List<EndpointInfo> Enumerate(
        DataFlow flow,
        IReadOnlyList<(DataFlow Flow, Role Role, string DeviceId)> defaults)
    {
        using var collection = enumerator.EnumerateAudioEndPoints(flow, DeviceState.All);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<EndpointInfo>();
        foreach (var device in collection)
        {
            using (device)
            {
                if (!seen.Add(device.ID)) continue;
                var supported = device.State == DeviceState.Active;
                result.Add(new EndpointInfo(
                    device.ID,
                    device.FriendlyName,
                    flow.ToString().ToLowerInvariant(),
                    device.State.ToString().ToLowerInvariant(),
                    supported,
                    defaults.Where(item => item.Flow == flow && item.DeviceId == device.ID)
                        .Select(item => item.Role.ToString().ToLowerInvariant())
                        .OrderBy(role => role, StringComparer.Ordinal)
                        .ToList(),
                    supported ? null : $"Endpoint state is {device.State}."));
            }
        }
        return result.OrderBy(endpoint => endpoint.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    public void Dispose()
    {
        notifications.Dispose();
        enumerator.Dispose();
    }
}
