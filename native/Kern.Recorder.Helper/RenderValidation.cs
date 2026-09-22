using System.Security.Cryptography;
using System.Text.Json;
using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal static class RenderValidation
{
    // throughMs: render a still-recording session up to that point. The manifest is opened with full
    // sharing so the capture helper's atomic replace of it is never blocked, and the terminal-state
    // check is waived; every segment-level check still applies.
    public static RenderPlan Load(RenderPaths paths, long? throughMs = null)
    {
        var live = throughMs is not null;
        if (throughMs is <= 0) throw new InvalidDataException("Render point must be a positive number of milliseconds.");
        var bytes = paths.ReadBytes("manifest.json", RenderConstants.MaxManifestBytes, shared: live);
        var session = JsonSerializer.Deserialize<SessionManifest>(bytes, Protocol.JsonOptions)
            ?? throw new InvalidDataException("Empty source manifest.");
        var terminal = session.State is "stopped" or "interrupted" && session.EndedAtUtc is not null;
        if (session.ProtocolVersion != Protocol.Version || session.ManifestVersion is < 1 or > 2 ||
            (!terminal && !live) || string.IsNullOrWhiteSpace(session.State) ||
            !Guid.TryParseExact(session.SessionId, "D", out _) || session.TimelineFrequency is < 1 or > 10_000_000_000 ||
            session.DurationMs < 0 || session.Tracks is null || session.Segments is null || session.Gaps is null ||
            session.Tracks.Count > 64 || session.Segments.Count > 100_000)
            throw new InvalidDataException("Unsupported, nonterminal or invalid source manifest; recover capture first.");
        if (session.ManifestVersion == 2 && session.TimelineOriginTicks is null or < 0)
            throw new InvalidDataException("Version 2 needs an explicit session timeline origin.");
        var warnings = new List<string>();
        if (session.ManifestVersion == 1)
            warnings.Add("legacy-timing-uncertain: v1 uses helper-lifetime ticks; origin and gaps inside segments cannot be reconstructed exactly. No time stretching is applied.");
        if (session.State == "interrupted") warnings.Add("recovered-or-interrupted: only finalized manifest segments are rendered.");
        var origin = session.TimelineOriginTicks ?? 0;
        var tracks = session.Tracks.ToDictionary(track => track.TrackId, StringComparer.Ordinal);
        var inputs = new List<RenderInput>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sampleCount = Scale(session.DurationMs, RenderConstants.Rate, 1000);
        var timingMismatches = 0;
        var overlappingRuns = 0;
        foreach (var segment in session.Segments)
        {
            if (segment is null || string.IsNullOrWhiteSpace(segment.SegmentId) || !ids.Add(segment.SegmentId) ||
                segment.RelativePath is null || !names.Add(segment.RelativePath.Replace('\\', '/')) ||
                !segment.RelativePath.Replace('\\', '/').StartsWith("segments/", StringComparison.Ordinal) ||
                !segment.RelativePath.EndsWith(".wav", StringComparison.OrdinalIgnoreCase) ||
                segment.Status != "finalised" || segment.Sequence < 0 || segment.Generation < 1 ||
                segment.TimelineStartTicks < origin || segment.TimelineEndTicks < segment.TimelineStartTicks ||
                segment.SampleCount <= 0 || segment.ByteLength is <= 0 or > RenderConstants.MaxSegmentBytes ||
                !IsHash(segment.Sha256) || !tracks.TryGetValue(segment.TrackId, out var track))
                throw new InvalidDataException("Invalid or unfinished source segment.");
            var pathParts = segment.RelativePath.Replace('\\', '/').Split('/');
            if (pathParts.Length is not (2 or 3) || (pathParts.Length == 3 && pathParts[1] != segment.TrackId))
                throw new InvalidDataException("Source path is outside its declared track directory.");
            var format = CanonicalFormat(track.Format);
            ValidateFormat(format);
            ValidateSegment(paths, segment, format);
            var start = Scale(segment.TimelineStartTicks - origin, RenderConstants.Rate, session.TimelineFrequency);
            var frames = Scale(segment.SampleCount, RenderConstants.Rate, track.Format.SampleRate);
            if (frames == 0) throw new InvalidDataException("Source segment is shorter than one output sample.");
            var reportedFrames = Scale(segment.TimelineEndTicks - segment.TimelineStartTicks,
                RenderConstants.Rate, session.TimelineFrequency);
            if (Math.Abs(reportedFrames - frames) > RenderConstants.Rate / 50) timingMismatches++;
            inputs.Add(new RenderInput(segment, format, RenderConstants.LaneFor(track.Kind), start, frames));
            sampleCount = Math.Max(sampleCount, checked(start + frames));
        }
        foreach (var group in inputs.GroupBy(input => input.Segment.TrackId))
        {
            long previousEnd = 0;
            foreach (var input in group.OrderBy(input => input.StartSample))
            {
                if (input.StartSample < previousEnd) overlappingRuns++;
                previousEnd = Math.Max(previousEnd, input.StartSample + input.SampleCount);
            }
        }
        foreach (var run in RenderRuns.Group(inputs))
            sampleCount = Math.Max(sampleCount, checked(run.StartSample + run.SampleCount));
        // Cloud window coordinates use integer milliseconds; pad by less than 1 ms.
        sampleCount = checked((sampleCount + 15) / 16 * 16);
        if (sampleCount <= 0 || sampleCount > RenderConstants.MaxSamples || checked(sampleCount * RenderConstants.FrameBytes + 44) > uint.MaxValue)
            throw new InvalidDataException("Unsupported call duration: canonical RIFF rendering is limited to 12 hours.");
        if (timingMismatches > 0) warnings.Add($"segment-timing-mismatch: {timingMismatches} segments; sample duration preserved, unknown internal gaps not invented.");
        if (overlappingRuns > 0) warnings.Add($"overlapping-source-runs: {overlappingRuns} overlaps; samples retained and mixed.");
        warnings.Add("timing-policy: segment starts use capture timestamps; sample durations use nominal rates. Within-run clock drift is not corrected without verified anchors.");
        warnings.Add("mix-policy: all recorded endpoints retained; no duplicate suppression or acoustic echo cancellation.");
        if (throughMs is { } through)
        {
            // Floor to the same 1 ms grid the padded total uses, then never look past what has been captured.
            var throughSamples = Scale(through, RenderConstants.Rate, 1000) / 16 * 16;
            if (throughSamples > sampleCount) throw new InvalidDataException("Requested render point exceeds available audio.");
            sampleCount = throughSamples;
        }
        return new RenderPlan(session, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(), sampleCount, inputs, warnings, live);
    }

    public static void ValidateSegment(RenderPaths paths, SegmentManifest segment, TrackFormat format)
    {
        format = CanonicalFormat(format);
        ValidateFormat(format);
        using var stream = paths.OpenRead(segment.RelativePath);
        if (stream.Length != segment.ByteLength || !Hash(stream).Equals(segment.Sha256, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Source integrity failed: {segment.SegmentId}");
        RenderWaveValidation.Validate(stream, segment, format);
        using var reader = new WaveFileReader(stream);
        var wave = reader.WaveFormat;
        if (reader.Length != checked(segment.SampleCount * format.BlockAlign) ||
            wave.SampleRate != format.SampleRate || wave.Channels != format.Channels ||
            wave.BitsPerSample != format.BitsPerSample || wave.BlockAlign != format.BlockAlign ||
            wave.AverageBytesPerSecond != format.AverageBytesPerSecond || wave.Encoding.ToString() != format.Encoding)
            throw new InvalidDataException($"Source WAV format/length mismatch: {segment.SegmentId}");
        if (wave.Encoding != WaveFormatEncoding.Extensible && format.SubFormat is not null)
            throw new InvalidDataException("Unexpected source WAV subformat.");
    }
    public static string Hash(Stream stream) => Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    public static bool IsHash(string? hash) => hash is { Length: 64 } && hash.All(Uri.IsHexDigit);
    public static long Scale(long value, long numerator, long denominator) => checked((long)((Int128)value * numerator / denominator));
    private static TrackFormat CanonicalFormat(TrackFormat format)
    {
        if (format is null) throw new InvalidDataException("Missing source audio format.");
        var encoding = format.Encoding switch
        {
            "pcm" or "Pcm" => "Pcm",
            "ieeefloat" or "IeeeFloat" => "IeeeFloat",
            "extensible" or "Extensible" => "Extensible",
            _ => throw new InvalidDataException("Unsupported source audio format."),
        };
        return format with { Encoding = encoding };
    }

    private static void ValidateFormat(TrackFormat format)
    {
        if (format is null || format.SampleRate is < 8000 or > 192000 || format.Channels is < 1 or > 32 ||
            format.BitsPerSample is not (8 or 16 or 24 or 32) ||
            format.BlockAlign != format.Channels * format.BitsPerSample / 8 ||
            format.AverageBytesPerSecond != format.SampleRate * format.BlockAlign ||
            format.Encoding is not ("Pcm" or "IeeeFloat" or "Extensible") ||
            (format.Encoding == "IeeeFloat" && format.BitsPerSample != 32))
            throw new InvalidDataException("Unsupported source audio format.");
        if (format.Encoding == "Extensible")
        {
            if (!Guid.TryParse(format.SubFormat, out var sub) ||
                (sub != new Guid("00000001-0000-0010-8000-00aa00389b71") && sub != new Guid("00000003-0000-0010-8000-00aa00389b71")) ||
                (sub == new Guid("00000003-0000-0010-8000-00aa00389b71") && format.BitsPerSample != 32) ||
                format.ValidBitsPerSample is null or <= 0 || format.ValidBitsPerSample > format.BitsPerSample)
                throw new InvalidDataException("Unsupported extensible source format.");
        }
    }
}
