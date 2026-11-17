using System.Security.Cryptography;
using System.Text;

namespace Kern.Recorder.Helper;

// Which sources a session records and how each one is reopened.
internal sealed partial class RecorderEngine
{
    private const string MicrophoneMode = "microphone";
    private const string EndpointLoopbackMode = "endpoint-loopback";

    // Called under the engine lock before the session is published, and every source failure
    // after that is contained by SourceSet, so no source can prevent or end a recording.
    //
    // The far side is endpoint loopback on every active render endpoint, followed as devices
    // come and go. Process loopback (ActivateAudioInterfaceAsync, exclude-Kern mode) is not
    // used: for some apps, the new Teams client among them, it activates, initializes and starts
    // cleanly and then delivers nothing but zeros, so there is no failure to fall back on.
    // Build 27 recorded a 28-minute call that way with the "them" lane 100% digital silence.
    // Endpoint loopback hears whatever reaches a device, whichever device the call app chose.
    private void OpenSources(CallSession active)
    {
        var now = clock.NowTicks;
        active.Sources.Add(new SourceSlot("microphone", CallAudio.MeLane, MicrophoneMode, "Microphone",
            new SourcePipeline(CallAudio.MeLane, active.Clock, active.Mixer), () => OpenMicrophone(active)), now);
        ReconcileEndpoints(active, now);
    }

    // The chosen microphone first, every time, so it is picked up again once it is back; the
    // default communications microphone only while the chosen one cannot be opened.
    private ICaptureSource OpenMicrophone(CallSession active)
    {
        try
        {
            var source = backend.OpenMicrophone(active.Microphone);
            active.MicFallback = false;
            return source;
        }
        catch (Exception) when (active.Microphone.Mode == "device")
        {
            var source = backend.OpenMicrophone(new MicrophoneSelection("default", null));
            active.MicFallback = true;
            return source;
        }
    }

    private bool ReconcileEndpoints(CallSession active, long now)
    {
        IReadOnlyDictionary<string, string> endpoints;
        try { endpoints = backend.ActiveRenderEndpoints(); }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or InvalidOperationException) { return false; }
        return active.Sources.Reconcile(endpoints, now, (endpointId, name) =>
            new SourceSlot(EndpointSourceId(endpointId), CallAudio.ThemLane, EndpointLoopbackMode, name,
                new SourcePipeline(CallAudio.ThemLane, active.Clock, active.Mixer), () => backend.OpenEndpointLoopback(endpointId))
            {
                EndpointId = endpointId,
            });
    }

    // Stable per device across reconnects, short, and free of the raw endpoint path.
    internal static string EndpointSourceId(string endpointId) =>
        "playback-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(endpointId)))[..12].ToLowerInvariant();
}
