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
        const string json = "{\"sessionId\":\"f0b03de7-d139-4c32-b92f-7c5bdd57a9f5\",\"sessionPath\":\"C:\\\\recording\",\"microphone\":{\"mode\":\"default\"},\"segmentDurationMs\":5000}";
        using var document = JsonDocument.Parse(json);

        // segmentDurationMs was protocol 1; a desktop still sending it must be refused loudly.
        Assert.Throws<JsonException>(() => document.RootElement.Deserialize<StartRequest>(Protocol.JsonOptions));
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
        var options = HelperOptions.Parse(["--pipe", "kern-recorder-abc", "--parent-pid", "42", "--protocol", "2"]);

        Assert.Equal("kern-recorder-abc", options.PipeName);
        Assert.Equal(42, options.ParentProcessId);
        Assert.Equal(Protocol.Version, options.ProtocolVersion);
        Assert.Null(options.AppBuild);
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse(["--wat", "x"]));
    }

    [Fact]
    public void ParsesAndValidatesAppBuildLabel()
    {
        string[] baseline = ["--pipe", "kern-recorder-abc", "--parent-pid", "42", "--protocol", "2"];
        var options = HelperOptions.Parse([.. baseline, "--app-build", "1.1.0-capture.20+1e09e1e"]);
        Assert.Equal("1.1.0-capture.20+1e09e1e", options.AppBuild);
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse([.. baseline, "--app-build", ""]));
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse([.. baseline, "--app-build", "has space"]));
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse([.. baseline, "--app-build", new string('a', 101)]));
    }

    [Fact]
    public void StartRequestParsesWithoutOptionalDeviceId()
    {
        using var document = JsonDocument.Parse(
            "{\"sessionId\":\"f0b03de7-d139-4c32-b92f-7c5bdd57a9f5\",\"sessionPath\":\"C:\\\\r\",\"microphone\":{\"mode\":\"default\"}}");

        var request = document.RootElement.Deserialize<StartRequest>(Protocol.JsonOptions);

        Assert.NotNull(request);
        Assert.Equal(new MicrophoneSelection("default", null), request.Microphone);
    }

    [Fact]
    public void HelperReportsVersionTwo() => Assert.Equal("2.0.0.0", RecorderEngine.HelperVersion);

    [Fact]
    public void RejectsProtocolOneHelperArguments()
    {
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse(["--pipe", "kern-recorder-abc", "--parent-pid", "42", "--protocol", "1"]));
    }

    [Fact]
    public void StatusSerialisesToTheProtocolTwoShapeWithExplicitNulls()
    {
        var status = new RecorderStatus("recording", "f0b03de7-d139-4c32-b92f-7c5bdd57a9f5", "2026-09-22T09:00:00.0000000+00:00",
            1500, 800, false, "all-apps",
            [new SourceStatus("microphone", "me", "Microphone (FIFINE K670)", "microphone", "active", 0.42, null,
                new SourceStats(150, 72_000, 24_000, 0, 0, 0, 0, 0))],
            null, null);

        using var json = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(status, Protocol.JsonOptions));
        var root = json.RootElement;

        Assert.Equal(
            ["state", "sessionId", "startedAtUtc", "elapsedMs", "committedFrames", "micMuted", "playbackMode", "sources", "failure", "warning"],
            root.EnumerateObject().Select(property => property.Name));
        Assert.Equal(JsonValueKind.Null, root.GetProperty("failure").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("warning").ValueKind);
        var source = root.GetProperty("sources")[0];
        Assert.Equal(["id", "lane", "name", "mode", "state", "level", "message", "stats"], source.EnumerateObject().Select(property => property.Name));
        Assert.Equal(JsonValueKind.Null, source.GetProperty("message").ValueKind);
        Assert.Equal(
            ["packets", "inputFrames", "outputFrames", "gaps", "gapFrames", "lateFrames", "resyncs", "droppedFrames"],
            source.GetProperty("stats").EnumerateObject().Select(property => property.Name));
    }

    [Fact]
    public void SessionDocumentSerialisesToTheSpecShape()
    {
        var document = new SessionDocument(SessionDocument.FormatName, "f0b03de7-d139-4c32-b92f-7c5bdd57a9f5", "recording",
            "2026-09-22T09:00:00.0000000+00:00", null, CallAudio.SampleRate, CallAudio.Channels, CallAudio.LaneNames, 0,
            new ProducerInfo("1.1.0-capture.30+abc1234", "2.0.0.0", Protocol.Version), "devices",
            [new SessionSource("playback-0123456789ab", "them", "Headphones (AirPods Pro)", "endpoint-loopback", "idle", null,
                new SourceStats(0, 0, 0, 0, 0, 0, 0, 0))],
            [new PauseSpan(16_000, null, "user")], null);

        using var json = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(document, Protocol.JsonOptions));
        var root = json.RootElement;

        Assert.Equal(
            ["format", "sessionId", "state", "startedAtUtc", "endedAtUtc", "sampleRate", "channels", "lanes", "committedFrames",
                "producer", "playbackMode", "sources", "pauses", "failure"],
            root.EnumerateObject().Select(property => property.Name));
        Assert.Equal("kern-call-audio/1", root.GetProperty("format").GetString());
        Assert.Equal(["me", "them"], root.GetProperty("lanes").EnumerateArray().Select(lane => lane.GetString()));
        Assert.Equal(2, root.GetProperty("producer").GetProperty("protocol").GetInt32());
        Assert.Equal(JsonValueKind.Null, root.GetProperty("endedAtUtc").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("pauses")[0].GetProperty("endFrame").ValueKind);
        Assert.False(root.GetProperty("sources")[0].TryGetProperty("level", out _));
        var parsed = JsonSerializer.Deserialize<SessionDocument>(json.RootElement.GetRawText(), Protocol.JsonOptions);
        Assert.Equal(document.Producer, parsed!.Producer);
    }
}
