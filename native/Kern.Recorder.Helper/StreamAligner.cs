namespace Kern.Recorder.Helper;

// Decides where on the session timeline each converted packet of one source goes. Contiguous
// audio stays contiguous regardless of delivery jitter or bursts; only a real hole (the source
// went quiet or lost audio) or a runaway clock moves the write position to the wall clock.
internal sealed class StreamAligner
{
    public const long GapFrames = CallAudio.SampleRate / 4;
    public const long ResyncFrames = CallAudio.SampleRate * 2;
    public const long QpcWindowFrames = CallAudio.SampleRate * 2;

    private long? cursor;

    public long Gaps { get; private set; }
    public long GapFramesTotal { get; private set; }
    public long Resyncs { get; private set; }

    // callbackFrame is when the packet reached us; qpcFrame is WASAPI's stamp for its first
    // sample, null when WASAPI flagged it untrustworthy. A stamp outside the last 2 s is
    // treated as garbage: Bluetooth drivers have been seen reporting stale or future values.
    public long Place(int samples, long callbackFrame, long? qpcFrame)
    {
        var wallStart = qpcFrame is long stamped && stamped <= callbackFrame && stamped >= callbackFrame - QpcWindowFrames
            ? stamped
            : callbackFrame - samples;
        if (cursor is not long current) return wallStart;
        if (wallStart - current > GapFrames)
        {
            Gaps++;
            GapFramesTotal += wallStart - current;
            return wallStart;
        }
        if (current - wallStart > ResyncFrames)
        {
            Resyncs++;
            return wallStart;
        }
        return current;
    }

    // Called with where the mixer actually put the packet, which may be later than proposed.
    public void Accept(long start, int samples) => cursor = start + samples;
}
