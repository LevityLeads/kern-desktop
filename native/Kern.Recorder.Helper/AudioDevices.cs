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

    public MMDevice OpenActiveRenderDevice(string endpointId)
    {
        var device = enumerator.GetDevice(endpointId);
        if (device.DataFlow == DataFlow.Render && device.State == DeviceState.Active) return device;
        device.Dispose();
        throw new InvalidOperationException("Playback device is not active.");
    }

    // In endpoint-loopback mode every active playback endpoint is captured, not just the
    // multimedia default: Teams and Zoom use the communications default, browsers the
    // multimedia default, and all of them let the user pick a device in-app.
    public Dictionary<string, string> ActiveRenderEndpoints()
    {
        using var collection = enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active);
        var endpoints = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 0; i < collection.Count; i++)
        {
            using var device = collection[i];
            endpoints[device.ID] = device.FriendlyName;
        }
        return endpoints;
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
