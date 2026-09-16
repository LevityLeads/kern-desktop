using NAudio.Wave;

namespace Kern.Recorder.Helper;

internal sealed record RenderRun(IReadOnlyList<RenderInput> Inputs, long StartSample, long SampleCount);
internal static class RenderRuns
{
    public static IEnumerable<RenderRun> Group(IReadOnlyList<RenderInput> inputs)
    {
        foreach (var track in inputs.GroupBy(input => input.Segment.TrackId).OrderBy(group => group.Key, StringComparer.Ordinal))
        {
            var current = new List<RenderInput>();
            long sourceFrames = 0;
            foreach (var input in track.OrderBy(item => item.StartSample).ThenBy(item => item.Segment.Sequence))
            {
                if (current.Count > 0)
                {
                    var first = current[0];
                    var expected = first.StartSample + RenderValidation.Scale(sourceFrames, RenderConstants.Rate, first.Format.SampleRate);
                    // Permit only floor-to-sample rounding. Real jumps begin a new run.
                    if (input.Format != first.Format || input.Segment.Generation != first.Segment.Generation ||
                        Math.Abs(input.StartSample - expected) > 1)
                    {
                        yield return Build(current, sourceFrames);
                        current = [];
                        sourceFrames = 0;
                    }
                }
                current.Add(input);
                sourceFrames = checked(sourceFrames + input.Segment.SampleCount);
            }
            if (current.Count > 0) yield return Build(current, sourceFrames);
        }
    }
    private static RenderRun Build(List<RenderInput> inputs, long frames) => new(inputs, inputs[0].StartSample,
        RenderValidation.Scale(frames, RenderConstants.Rate, inputs[0].Format.SampleRate));
}

// Keep WDL filter state across adjacent chunks with one open source decoder.
internal sealed class RenderRunProvider : ISampleProvider, IDisposable
{
    private readonly RenderPaths paths;
    private readonly IReadOnlyList<RenderInput> inputs;
    private int index;
    private FileStream? stream;
    private WaveFileReader? reader;
    private RenderMonoProvider? provider;
    private long remainingFrames;
    public WaveFormat WaveFormat { get; }
    public RenderRunProvider(RenderPaths paths, RenderRun run)
    {
        this.paths = paths;
        inputs = run.Inputs;
        WaveFormat = WaveFormat.CreateIeeeFloatWaveFormat(inputs[0].Format.SampleRate, 1);
    }
    public int Read(Span<float> destination)
    {
        var written = 0;
        while (written < destination.Length)
        {
            if (provider is null)
            {
                if (index == inputs.Count) break;
                Open(inputs[index++]);
            }
            var wanted = (int)Math.Min(destination.Length - written, remainingFrames);
            var count = provider!.Read(destination.Slice(written, wanted));
            if (count == 0) throw new InvalidDataException("Decoder ended before declared source frames.");
            remainingFrames -= count;
            written += count;
            if (remainingFrames == 0) CloseCurrent();
        }
        return written;
    }
    private void Open(RenderInput input)
    {
        stream = paths.OpenRead(input.Segment.RelativePath);
        try
        {
            if (stream.Length != input.Segment.ByteLength || !RenderValidation.Hash(stream).Equals(input.Segment.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Source changed during rendering.");
            RenderWaveValidation.Validate(stream, input.Segment, input.Format);
            reader = new WaveFileReader(stream);
            provider = new RenderMonoProvider(reader.ToSampleProvider());
            remainingFrames = input.Segment.SampleCount;
        }
        catch { CloseCurrent(); throw; }
    }
    private void CloseCurrent()
    {
        provider = null;
        reader?.Dispose();
        reader = null;
        stream?.Dispose();
        stream = null;
    }
    public void Dispose() => CloseCurrent();
}
