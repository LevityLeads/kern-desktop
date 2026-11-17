using System.Diagnostics;

namespace Kern.Recorder.Helper;

internal sealed class TimelineClock
{
    private readonly Func<long> timestamp;
    private readonly long origin;

    public TimelineClock(Func<long>? timestamp = null)
    {
        this.timestamp = timestamp ?? Stopwatch.GetTimestamp;
        origin = this.timestamp();
    }

    public long NowTicks => timestamp() - origin;
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
    public static long ElapsedMilliseconds(long originTicks, long nowTicks) =>
        ToMilliseconds(Math.Max(0, checked(nowTicks - originTicks)));
    public static long ToMilliseconds(long ticks) => Scale(ticks, 1000, Frequency);
}
