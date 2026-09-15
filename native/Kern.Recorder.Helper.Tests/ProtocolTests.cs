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
        Assert.Throws<ArgumentException>(() => HelperOptions.Parse(["--wat", "x"]));
    }
}
