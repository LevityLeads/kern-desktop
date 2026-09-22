using System.Buffers.Binary;
using System.Text.Json;
using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class ProtocolTests
{
    [Fact]
    public async Task RoundTripsLengthPrefixedMessage()
    {
        await using var stream = new MemoryStream();
        await Protocol.WriteAsync(stream, new { type = "event", value = 42 }, CancellationToken.None);
        stream.Position = 0;

        using var message = await Protocol.ReadAsync(stream, CancellationToken.None);

        Assert.NotNull(message);
        Assert.Equal("event", message.RootElement.GetProperty("type").GetString());
        Assert.Equal(42, message.RootElement.GetProperty("value").GetInt32());
    }

    [Fact]
    public async Task RejectsOversizedFrameBeforeAllocation()
    {
        var bytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, Protocol.MaximumMessageBytes + 1u);
        await using var stream = new MemoryStream(bytes);

        await Assert.ThrowsAsync<InvalidDataException>(() => Protocol.ReadAsync(stream, CancellationToken.None));
    }

    [Fact]
    public void TypedPayloadsRejectUnknownProperties()
    {
        const string json = "{\"sessionId\":\"f0b03de7-d139-4c32-b92f-7c5bdd57a9f5\",\"sessionPath\":\"C:\\\\recording\",\"extra\":true}";
        using var document = JsonDocument.Parse(json);

        Assert.Throws<JsonException>(() => document.RootElement.Deserialize<RecoverRequest>(Protocol.JsonOptions));
    }

    [Fact]
    public void RejectsUnknownRequestEnvelopeProperties()
    {
        using var document = JsonDocument.Parse("{\"type\":\"request\",\"protocolVersion\":1,\"requestId\":1,\"command\":\"ping\",\"payload\":{},\"extra\":true}");

        Assert.Throws<ProtocolException>(() => Protocol.RequirePayload(document.RootElement));
    }

    [Fact]
    public void ParsesStrictHelperArguments()
    {
        var options = HelperOptions.Parse(["--pipe", "kern-recorder-abc", "--parent-pid", "42", "--protocol", "1"]);

        Assert.Equal("kern-recorder-abc", options.PipeName);
        Assert.Equal(42, options.ParentProcessId);
        Assert.Equal(Protocol.Version, options.ProtocolVersion);
        Assert.Null(options.AppBuild);
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse(["--wat", "x"]));
    }

    [Fact]
    public void ParsesAndValidatesAppBuildLabel()
    {
        string[] baseline = ["--pipe", "kern-recorder-abc", "--parent-pid", "42", "--protocol", "1"];
        var options = HelperOptions.Parse([.. baseline, "--app-build", "1.1.0-capture.20+1e09e1e"]);
        Assert.Equal("1.1.0-capture.20+1e09e1e", options.AppBuild);
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse([.. baseline, "--app-build", ""]));
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse([.. baseline, "--app-build", "has space"]));
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse([.. baseline, "--app-build", new string('a', 101)]));
    }

    [Fact]
    public void ManifestProducerDevicesAndCountersRoundTripUnderStrictJson()
    {
        var manifest = new SessionManifest
        {
            SessionId = "f0b03de7-d139-4c32-b92f-7c5bdd57a9f5",
            State = "stopped",
            StartedAtUtc = "2026-09-22T09:00:00.0000000+00:00",
            TimelineFrequency = TimelineClock.Frequency,
            TimelineOriginTicks = 0,
            ManifestVersion = 2,
            Producer = new ProducerInfo("1.1.0-capture.20+1e09e1e", "1.0.0.0", Protocol.Version),
            DevicesAtStart = new DeviceList(
                [new EndpointInfo("{render}", "Headphones (AirPods Pro)", "render", "active", true, ["communications", "multimedia"])],
                [new EndpointInfo("{capture}", "Microphone (FIFINE K670)", "capture", "active", true, [])]),
        };
        manifest.Tracks.Add(new TrackManifest
        {
            TrackId = "render-x", EndpointId = "{render}", Name = "Headphones (AirPods Pro)", Kind = "render",
            DefaultRoles = ["multimedia"], Format = new TrackFormat(48000, 2, 32, 8, 384000, "extensible", 32, 3, "00000003-0000-0010-8000-00aa00389b71"),
            Counters = new TrackCounters(1000, 480000, 240000, 200000, 900, 3, 0, 0, 1),
        });

        var json = JsonSerializer.SerializeToUtf8Bytes(manifest, Protocol.JsonOptions);
        var parsed = JsonSerializer.Deserialize<SessionManifest>(json, Protocol.JsonOptions);

        Assert.NotNull(parsed);
        Assert.Equal(manifest.Producer, parsed.Producer);
        Assert.Equal("Headphones (AirPods Pro)", parsed.DevicesAtStart!.RenderEndpoints[0].Name);
        Assert.Equal(["communications", "multimedia"], parsed.DevicesAtStart.RenderEndpoints[0].DefaultRoles);
        Assert.Equal(manifest.Tracks[0].Counters, parsed.Tracks[0].Counters);
        // Older manifests without these fields still load.
        var legacy = JsonSerializer.Deserialize<SessionManifest>(
            "{\"protocolVersion\":1,\"manifestVersion\":2,\"sessionId\":\"f0b03de7-d139-4c32-b92f-7c5bdd57a9f5\",\"state\":\"stopped\",\"startedAtUtc\":\"x\",\"timelineFrequency\":10000000,\"timelineOriginTicks\":0,\"durationMs\":0,\"sizeBytes\":0,\"captureGeneration\":1,\"micMuted\":false,\"tracks\":[],\"segments\":[],\"gaps\":[]}",
            Protocol.JsonOptions);
        Assert.NotNull(legacy);
        Assert.Null(legacy.Producer);
        Assert.Null(legacy.DevicesAtStart);
    }
}
