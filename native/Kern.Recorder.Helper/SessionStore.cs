using System.Security.Cryptography;
using System.Text.Json;

namespace Kern.Recorder.Helper;

internal sealed class SessionStore
{
    private const string SegmentMetadataSuffix = ".metadata.json";
    private readonly object gate = new();
    private readonly string sessionPath;
    private readonly string manifestPath;
    private readonly string journalPath;

    public SessionStore(string sessionPath, SessionManifest manifest)
    {
        this.sessionPath = Path.GetFullPath(sessionPath);
        manifestPath = Path.Combine(this.sessionPath, "manifest.json");
        journalPath = Path.Combine(this.sessionPath, "journal.ndjson");
        Manifest = manifest;
        WindowsNative.RestrictDirectoryToCurrentUser(this.sessionPath);
        Directory.CreateDirectory(Path.Combine(this.sessionPath, "segments"));
        PersistManifest();
        Append("session-started", new { manifest.SessionId, manifest.StartedAtUtc });
    }

    private SessionStore(string sessionPath, SessionManifest manifest, bool recovered)
    {
        this.sessionPath = Path.GetFullPath(sessionPath);
        manifestPath = Path.Combine(this.sessionPath, "manifest.json");
        journalPath = Path.Combine(this.sessionPath, "journal.ndjson");
        Manifest = manifest;
        _ = recovered;
    }

    public SessionManifest Manifest { get; }
    public string SessionPath => sessionPath;

    public static SessionStore Open(string sessionPath, string sessionId)
    {
        var canonical = Path.GetFullPath(sessionPath);
        var manifestPath = Path.Combine(canonical, "manifest.json");
        var manifest = JsonSerializer.Deserialize<SessionManifest>(File.ReadAllBytes(manifestPath), Protocol.JsonOptions)
            ?? throw new InvalidDataException("Session manifest is empty.");
        if (manifest.ProtocolVersion != Protocol.Version || manifest.SessionId != sessionId)
            throw new InvalidDataException("Session manifest identity or protocol does not match.");
        ValidateJournal(Path.Combine(canonical, "journal.ndjson"), sessionId);
        return new SessionStore(canonical, manifest, recovered: true);
    }

    public void AddTrack(TrackManifest track)
    {
        lock (gate)
        {
            if (Manifest.Tracks.Any(existing => existing.TrackId == track.TrackId)) return;
            Manifest.Tracks.Add(track);
            Append("track-added", track);
            PersistManifest();
        }
    }

    public void AddSegment(SegmentManifest segment)
    {
        lock (gate)
        {
            if (Manifest.Segments.Any(existing => existing.SegmentId == segment.SegmentId)) return;
            Manifest.Segments.Add(segment);
            Manifest.SizeBytes = checked(Manifest.SizeBytes + segment.ByteLength);
            Append("segment-published", segment);
            PersistManifest();
        }
    }

    public GapManifest OpenGap(string scope, string reason, long startTicks, long generation, string provenance = "measured")
    {
        lock (gate)
        {
            var gap = new GapManifest(Guid.NewGuid().ToString("N"), scope, reason, startTicks, null, provenance, generation);
            Manifest.Gaps.Add(gap);
            Append("gap-opened", gap);
            PersistManifest();
            return gap;
        }
    }

    public void CloseGap(string gapId, long endTicks)
    {
        lock (gate)
        {
            var index = Manifest.Gaps.FindIndex(gap => gap.GapId == gapId);
            if (index < 0 || Manifest.Gaps[index].EndTicks is not null) return;
            Manifest.Gaps[index] = Manifest.Gaps[index] with { EndTicks = endTicks };
            Append("gap-closed", new { gapId, endTicks });
            PersistManifest();
        }
    }

    public void SetState(
        string state,
        long durationMs,
        bool micMuted,
        long generation,
        object? failure = null,
        long? requestedAtUnixMs = null,
        double? requestedAtMonotonicMs = null,
        long? effectiveCutoffTicks = null)
    {
        lock (gate)
        {
            Manifest.State = state;
            Manifest.DurationMs = durationMs;
            Manifest.MicMuted = micMuted;
            Manifest.CaptureGeneration = generation;
            Manifest.Failure = failure;
            if (state is "stopped" or "interrupted") Manifest.EndedAtUtc = DateTimeOffset.UtcNow.ToString("O");
            Append("state", new
            {
                state,
                durationMs,
                micMuted,
                generation,
                failure,
                requestedAtUnixMs,
                requestedAtMonotonicMs,
                effectiveCutoffTicks,
            });
            PersistManifest();
        }
    }

    public SessionManifest Recover()
    {
        lock (gate)
        {
            var journalSegments = ReadPublishedJournalSegments();
            var known = Manifest.Segments
                .Select(segment => NormalizePortablePath(segment.RelativePath))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
            var segmentsRoot = Path.Combine(sessionPath, "segments");
            var quarantine = Path.Combine(sessionPath, "quarantine");
            if (Directory.Exists(segmentsRoot))
            {
                foreach (var file in Directory.EnumerateFiles(segmentsRoot, "*.wav", SearchOption.AllDirectories))
                {
                    var relative = NormalizePortablePath(Path.GetRelativePath(sessionPath, file));
                    if (known.Contains(relative))
                    {
                        var committedMetadata = file + SegmentMetadataSuffix;
                        AtomicFile.DeleteBestEffort(committedMetadata);
                        continue;
                    }
                    try
                    {
                        var adopted = journalSegments.TryGetValue(relative, out var journalSegment)
                            ? journalSegment
                            : ReadSegmentMetadata(file);
                        ValidateSegmentMetadata(adopted, relative);
                        ValidateIdentity(file, adopted);
                        Manifest.Segments.Add(adopted);
                        Manifest.SizeBytes = checked(Manifest.SizeBytes + adopted.ByteLength);
                        known.Add(relative);
                        Append("segment-adopted", adopted);
                        var adoptedMetadata = file + SegmentMetadataSuffix;
                        AtomicFile.DeleteBestEffort(adoptedMetadata);
                    }
                    catch (Exception error)
                    {
                        Quarantine(file, quarantine, ".mismatch");
                        var metadataPath = file + SegmentMetadataSuffix;
                        if (File.Exists(metadataPath)) Quarantine(metadataPath, quarantine, ".mismatch");
                        Append("segment-quarantined", new { relativePath = relative, reason = error.Message });
                    }
                }
                foreach (var partial in Directory.EnumerateFiles(segmentsRoot, "*.partial", SearchOption.AllDirectories))
                {
                    Quarantine(partial, quarantine);
                    Append("partial-quarantined", new { relativePath = Path.GetRelativePath(sessionPath, partial) });
                }
                foreach (var metadata in Directory.EnumerateFiles(segmentsRoot, $"*{SegmentMetadataSuffix}", SearchOption.AllDirectories))
                {
                    var wav = metadata[..^SegmentMetadataSuffix.Length];
                    if (File.Exists(wav)) continue;
                    Quarantine(metadata, quarantine, ".orphan");
                    Append("metadata-quarantined", new { relativePath = Path.GetRelativePath(sessionPath, metadata), reason = "Segment file is missing." });
                }
                foreach (var metadataTemp in Directory.EnumerateFiles(segmentsRoot, $"*{SegmentMetadataSuffix}.tmp", SearchOption.AllDirectories))
                {
                    Quarantine(metadataTemp, quarantine, ".partial");
                    Append("metadata-partial-quarantined", new
                    {
                        relativePath = Path.GetRelativePath(sessionPath, metadataTemp),
                        reason = "Segment metadata write was interrupted.",
                    });
                }
            }

            foreach (var segment in Manifest.Segments.Where(segment => segment.Status == "finalised"))
            {
                var file = ResolveRelative(segment.RelativePath);
                ValidateIdentity(file, segment);
            }
            Manifest.State = "interrupted";
            Manifest.EndedAtUtc ??= DateTimeOffset.UtcNow.ToString("O");
            Manifest.Failure ??= new { code = "recovered-after-interruption", message = "Recovered durable segments after an interrupted session." };
            Append("session-recovered", new { Manifest.SessionId });
            PersistManifest();
            return Manifest;
        }
    }

    private Dictionary<string, SegmentManifest> ReadPublishedJournalSegments()
    {
        var result = new Dictionary<string, SegmentManifest>(StringComparer.OrdinalIgnoreCase);
        foreach (var document in ReadJournalDocuments(journalPath))
        {
            using (document)
            {
                var root = document.RootElement;
                if (!root.TryGetProperty("eventName", out var name) || name.GetString() != "segment-published") continue;
                if (!root.TryGetProperty("payload", out var payload)) continue;
                var segment = payload.Deserialize<SegmentManifest>(Protocol.JsonOptions);
                if (segment is not null) result[NormalizePortablePath(segment.RelativePath)] = segment;
            }
        }
        return result;
    }

    private static SegmentManifest ReadSegmentMetadata(string wavPath)
    {
        var metadataPath = wavPath + SegmentMetadataSuffix;
        if (!File.Exists(metadataPath)) throw new InvalidDataException("Published segment has no durable metadata.");
        return JsonSerializer.Deserialize<SegmentManifest>(File.ReadAllBytes(metadataPath), Protocol.JsonOptions)
            ?? throw new InvalidDataException("Published segment metadata is empty.");
    }

    private static void ValidateSegmentMetadata(SegmentManifest segment, string relativePath)
    {
        if (segment.Status != "finalised" ||
            string.IsNullOrWhiteSpace(segment.SegmentId) ||
            string.IsNullOrWhiteSpace(segment.TrackId) ||
            segment.Sequence < 0 ||
            segment.Generation < 1 ||
            segment.TimelineStartTicks < 0 ||
            segment.TimelineEndTicks < segment.TimelineStartTicks ||
            segment.SampleCount <= 0 ||
            segment.ByteLength <= 0 ||
            segment.Sha256.Length != 64 ||
            !segment.Sha256.All(Uri.IsHexDigit) ||
            NormalizePortablePath(segment.RelativePath) != relativePath)
            throw new InvalidDataException("Published segment metadata is invalid.");
    }

    private static void ValidateJournal(string journalPath, string sessionId)
    {
        if (!File.Exists(journalPath)) throw new InvalidDataException("Session journal is missing.");
        var sawStart = false;
        foreach (var document in ReadJournalDocuments(journalPath))
        {
            using (document)
            {
                var root = document.RootElement;
                if (!root.TryGetProperty("protocolVersion", out var version) || version.GetInt32() != Protocol.Version)
                    throw new InvalidDataException("Session journal protocol is invalid.");
                if (root.TryGetProperty("eventName", out var name) && name.GetString() == "session-started" &&
                    root.TryGetProperty("payload", out var payload) && payload.TryGetProperty("sessionId", out var journalSession))
                    sawStart |= journalSession.GetString() == sessionId;
            }
        }
        if (!sawStart) throw new InvalidDataException("Session journal has no matching start record.");
    }

    private static IEnumerable<JsonDocument> ReadJournalDocuments(string path)
    {
        var lines = File.ReadAllLines(path);
        for (var index = 0; index < lines.Length; index++)
        {
            var line = lines[index];
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonDocument? document = null;
            try
            {
                document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 16 });
            }
            catch (JsonException) when (index == lines.Length - 1 && !FileEndsWithNewline(path))
            {
                yield break;
            }
            yield return document;
        }
    }

    private static bool FileEndsWithNewline(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        if (stream.Length == 0) return true;
        stream.Position = stream.Length - 1;
        return stream.ReadByte() == (byte)'\n';
    }

    private static void ValidateIdentity(string file, SegmentManifest segment)
    {
        if (!File.Exists(file)) throw new InvalidDataException($"Finalised segment is missing: {segment.SegmentId}");
        var info = new FileInfo(file);
        if (info.Length != segment.ByteLength) throw new InvalidDataException($"Segment byte length mismatch: {segment.SegmentId}");
        var audioBytes = WavValidator.Validate(file);
        if (audioBytes <= 0 || audioBytes % segment.SampleCount != 0)
            throw new InvalidDataException($"Segment audio length is invalid: {segment.SegmentId}");
        using var stream = File.OpenRead(file);
        var actualChecksum = SHA256.HashData(stream);
        byte[] expectedChecksum;
        try { expectedChecksum = Convert.FromHexString(segment.Sha256); }
        catch (FormatException error) { throw new InvalidDataException($"Segment checksum is invalid: {segment.SegmentId}", error); }
        if (expectedChecksum.Length != actualChecksum.Length ||
            !CryptographicOperations.FixedTimeEquals(actualChecksum, expectedChecksum))
            throw new InvalidDataException($"Segment checksum mismatch: {segment.SegmentId}");
    }

    private string ResolveRelative(string relative)
    {
        var candidate = Path.GetFullPath(Path.Combine(sessionPath, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!candidate.StartsWith(sessionPath + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Manifest path escapes the session directory.");
        return candidate;
    }

    private static void Quarantine(string source, string quarantineDirectory, string suffix = "")
    {
        Directory.CreateDirectory(quarantineDirectory);
        var destination = Path.Combine(quarantineDirectory, Path.GetFileName(source) + suffix);
        if (File.Exists(destination)) destination += $"-{Guid.NewGuid():N}";
        File.Move(source, destination);
    }

    private static string NormalizePortablePath(string path) => path.Replace('\\', '/');

    private void Append(string eventName, object payload) => AtomicFile.AppendJournal(journalPath, new
    {
        protocolVersion = Protocol.Version,
        eventName,
        recordedAtUtc = DateTimeOffset.UtcNow.ToString("O"),
        payload,
    });

    private void PersistManifest() => AtomicFile.WriteJson(manifestPath, Manifest);
}
