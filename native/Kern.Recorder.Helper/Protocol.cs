using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kern.Recorder.Helper;

internal static class Protocol
{
    public const int Version = 1;
    public const int MaximumMessageBytes = 256 * 1024;
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    public static async Task<JsonDocument?> ReadAsync(Stream stream, CancellationToken cancellationToken)
    {
        var lengthBytes = new byte[4];
        if (!await ReadExactlyOrEndAsync(stream, lengthBytes, cancellationToken).ConfigureAwait(false)) return null;
        var length = BinaryPrimitives.ReadUInt32LittleEndian(lengthBytes);
        if (length is 0 or > MaximumMessageBytes) throw new InvalidDataException("Invalid protocol frame size.");
        var body = new byte[length];
        await stream.ReadExactlyAsync(body, cancellationToken).ConfigureAwait(false);
        return JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 16 });
    }

    public static async Task WriteAsync(Stream stream, object message, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        if (body.Length is 0 or > MaximumMessageBytes) throw new InvalidDataException("Protocol response is too large.");
        var lengthBytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(lengthBytes, (uint)body.Length);
        await stream.WriteAsync(lengthBytes, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(body, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    public static long RequireRequestId(JsonElement root)
    {
        if (!root.TryGetProperty("requestId", out var value) || !value.TryGetInt64(out var requestId) || requestId < 1)
            throw new ProtocolException("invalid-request", "requestId is invalid.");
        return requestId;
    }

    public static string RequireCommand(JsonElement root)
    {
        if (!root.TryGetProperty("command", out var value) || value.ValueKind != JsonValueKind.String)
            throw new ProtocolException("invalid-request", "command is missing.");
        var command = value.GetString();
        if (string.IsNullOrEmpty(command) || command.Length > 31 || command.Any(c => c != '-' && !char.IsAsciiLetterLower(c)))
            throw new ProtocolException("invalid-request", "command is invalid.");
        return command;
    }

    public static JsonElement RequirePayload(JsonElement root)
    {
        foreach (var property in root.EnumerateObject())
        {
            if (property.Name is not ("type" or "protocolVersion" or "requestId" or "command" or "payload"))
                throw new ProtocolException("invalid-request", $"Unknown request property: {property.Name}");
        }
        if (!root.TryGetProperty("payload", out var value) || value.ValueKind != JsonValueKind.Object)
            throw new ProtocolException("invalid-request", "payload must be an object.");
        return value;
    }

    private static async Task<bool> ReadExactlyOrEndAsync(Stream stream, Memory<byte> destination, CancellationToken cancellationToken)
    {
        var read = 0;
        while (read < destination.Length)
        {
            var count = await stream.ReadAsync(destination[read..], cancellationToken).ConfigureAwait(false);
            if (count == 0)
            {
                if (read == 0) return false;
                throw new EndOfStreamException("Protocol frame ended early.");
            }
            read += count;
        }
        return true;
    }
}

internal sealed class ProtocolException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
