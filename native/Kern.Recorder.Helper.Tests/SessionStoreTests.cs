using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class SessionStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"kern-session-test-{Guid.NewGuid():N}");

    public SessionStoreTests() => Directory.CreateDirectory(root);

    [Fact]
    public void PersistsManifestAndJournalBeforeReturning()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        var store = CreateStore(sessionId);

        store.SetState("recording", 12, false, 1);

        using var manifest = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "manifest.json")));
        Assert.Equal("recording", manifest.RootElement.GetProperty("state").GetString());
        var journal = File.ReadAllLines(Path.Combine(root, "journal.ndjson"));
        Assert.Contains(journal, line => line.Contains("session-started", StringComparison.Ordinal));
        Assert.Contains(journal, line => line.Contains("\"state\"", StringComparison.Ordinal));
    }

    [Fact]
    public void RecoveryQuarantinesIncompleteTail()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        var segmentDirectory = Path.Combine(root, "segments", "microphone-test");
        Directory.CreateDirectory(segmentDirectory);
        File.WriteAllBytes(Path.Combine(segmentDirectory, "000001-deadbeef.wav.partial"), [1, 2, 3]);

        var recovered = SessionStore.Open(root, sessionId).Recover();

        Assert.Equal("interrupted", recovered.State);
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(root, "segments"), "*.partial", SearchOption.AllDirectories));
        Assert.Single(Directory.EnumerateFiles(Path.Combine(root, "quarantine")));
    }

    [Fact]
    public void OpenIgnoresOnlyAnIncompleteFinalJournalLine()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        File.AppendAllText(Path.Combine(root, "journal.ndjson"), "{\"protocolVersion\":1");

        var recovered = SessionStore.Open(root, sessionId).Recover();

        Assert.Equal("interrupted", recovered.State);
    }

    [Fact]
    public void OpenRejectsMalformedCompleteJournalLine()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        File.AppendAllText(Path.Combine(root, "journal.ndjson"), "{bad-json}\n");

        Assert.ThrowsAny<JsonException>(() => SessionStore.Open(root, sessionId));
    }

    [Fact]
    public void RecoveryAdoptsPublishedSegmentFromDurableMetadata()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        var segment = PublishOrphanSegment("render-test", 0);

        var recovered = SessionStore.Open(root, sessionId).Recover();

        var adopted = Assert.Single(recovered.Segments);
        Assert.Equal(segment.SegmentId, adopted.SegmentId);
        Assert.Equal(segment.Sha256, adopted.Sha256);
        var wavPath = Path.Combine(root, adopted.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.False(File.Exists(wavPath + ".metadata.json"));
        Assert.Contains(File.ReadAllLines(Path.Combine(root, "journal.ndjson")),
            line => line.Contains("segment-adopted", StringComparison.Ordinal));
    }

    [Fact]
    public void RecoveryQuarantinesPublishedSegmentWithMismatchedMetadata()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        var segment = PublishOrphanSegment("render-test", 0);
        var wavPath = Path.Combine(root, segment.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        File.AppendAllText(wavPath, "tampered");

        var recovered = SessionStore.Open(root, sessionId).Recover();

        Assert.Empty(recovered.Segments);
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(root, "segments"), "*.wav", SearchOption.AllDirectories));
        Assert.Equal(2, Directory.EnumerateFiles(Path.Combine(root, "quarantine")).Count());
    }

    [Fact]
    public void RecoveryQuarantinesPublishedSegmentWithInvalidWavStructure()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        var segment = PublishOrphanSegment("render-test", 0);
        var wavPath = Path.Combine(root, segment.RelativePath.Replace('/', Path.DirectorySeparatorChar));
        using (var stream = new FileStream(wavPath, FileMode.Open, FileAccess.Write, FileShare.None))
        {
            stream.Position = 8;
            stream.Write("NOPE"u8);
        }
        var bytes = File.ReadAllBytes(wavPath);
        var metadataPath = wavPath + ".metadata.json";
        var metadata = JsonNode.Parse(File.ReadAllBytes(metadataPath))!.AsObject();
        metadata["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        File.WriteAllBytes(metadataPath, JsonSerializer.SerializeToUtf8Bytes(metadata, Protocol.JsonOptions));

        var recovered = SessionStore.Open(root, sessionId).Recover();

        Assert.Empty(recovered.Segments);
        Assert.Equal(2, Directory.EnumerateFiles(Path.Combine(root, "quarantine")).Count());
    }

    [Fact]
    public void RecoveryQuarantinesInterruptedMetadataWrite()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        var segmentDirectory = Path.Combine(root, "segments", "render-test");
        Directory.CreateDirectory(segmentDirectory);
        File.WriteAllText(Path.Combine(segmentDirectory, "000000-missing.wav.metadata.json.tmp"), "{");

        var recovered = SessionStore.Open(root, sessionId).Recover();

        Assert.Empty(recovered.Segments);
        Assert.Single(Directory.EnumerateFiles(Path.Combine(root, "quarantine")));
    }

    [Fact]
    public void RecoveryQuarantinesMetadataWithoutPublishedSegment()
    {
        var sessionId = Guid.NewGuid().ToString("D");
        _ = CreateStore(sessionId);
        var segmentDirectory = Path.Combine(root, "segments", "render-test");
        Directory.CreateDirectory(segmentDirectory);
        File.WriteAllText(Path.Combine(segmentDirectory, "000000-missing.wav.metadata.json"), "{}");

        var recovered = SessionStore.Open(root, sessionId).Recover();

        Assert.Empty(recovered.Segments);
        Assert.Single(Directory.EnumerateFiles(Path.Combine(root, "quarantine")));
    }

    private SessionStore CreateStore(string sessionId) => new(root, new SessionManifest
    {
        SessionId = sessionId,
        State = "recording",
        StartedAtUtc = DateTimeOffset.UtcNow.ToString("O"),
        TimelineFrequency = 10_000_000,
    });

    private SegmentManifest PublishOrphanSegment(string trackId, int sequence)
    {
        using var segment = new SegmentWriter(
            root,
            trackId,
            new WaveFormat(48_000, 16, 2),
            generation: 1,
            sequence,
            timelineStartTicks: 100);
        var samples = new byte[48_000 * 2 * 2 / 100];
        segment.Write(samples, devicePosition: 20, qpcPosition: 30, packetStartTicks: 100);
        return segment.Finalise(timelineEndTicks: 100_100);
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
