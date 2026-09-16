using System.Diagnostics;

namespace Kern.Recorder.Helper;

internal sealed class TimelineClock
{
    private readonly long origin = Stopwatch.GetTimestamp();

    public long NowTicks => Stopwatch.GetTimestamp() - origin;
    public static long Frequency => Stopwatch.Frequency;
    public long FromQpc100Nanoseconds(long qpcPosition) =>
        checked(Scale(qpcPosition, Frequency, 10_000_000L) - origin);
    internal static long Scale(long value, long numerator, long denominator)
    {
        if (value < 0 || numerator < 0 || denominator <= 0)
            throw new ArgumentOutOfRangeException(nameof(value), "Timeline scaling accepts non-negative values and a positive denominator.");
        var whole = value / denominator;
        var remainder = value % denominator;
        return checked(whole * numerator + remainder * numerator / denominator);
    }
    public static long DurationForFrames(long frames, int sampleRate) => Scale(frames, Frequency, sampleRate);
    public static long FramesForDuration(long ticks, int sampleRate)
    {
        if (ticks <= 0) return 0;
        var wholeSeconds = ticks / Frequency;
        var remainderTicks = ticks % Frequency;
        return checked(
            wholeSeconds * sampleRate +
            (remainderTicks * sampleRate + Frequency - 1) / Frequency);
    }
    public static long FramesBefore(long startTicks, long cutoffTicks, int sampleRate) =>
        cutoffTicks <= startTicks ? 0 : FramesForDuration(cutoffTicks - startTicks, sampleRate);
    public static long ElapsedMilliseconds(long originTicks, long nowTicks) =>
        ToMilliseconds(Math.Max(0, checked(nowTicks - originTicks)));
    public static long ToMilliseconds(long ticks) => Scale(ticks, 1000, Frequency);
}
