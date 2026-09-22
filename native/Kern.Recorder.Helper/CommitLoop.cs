namespace Kern.Recorder.Helper;

// Moves finished audio from the mixer to the sink. Called on a timer, never on a capture thread.
internal sealed class CommitLoop(CallMixer mixer, ICallSink sink) : IDisposable
{
    // Frames younger than this stay in the mixer so late Bluetooth packets can still land in
    // place instead of being shifted.
    public const long HorizonFrames = CallAudio.SampleRate * 3 / 2;
    public const long DurableFlushFrames = CallAudio.SampleRate * 2;

    private readonly object io = new();
    private readonly byte[] chunk = new byte[CallAudio.SampleRate * CallAudio.BytesPerFrame];
    private long committedFrames;
    private long lastDurableFlushFrame;
    private bool closed;

    // Frames the OS already holds for audio.pcm, i.e. what a reader of the file can see.
    public long CommittedFrames => Interlocked.Read(ref committedFrames);

    public void Pump(long nowFrame)
    {
        lock (io)
        {
            if (closed) return;
            CloseOnFailure(() =>
            {
                Drain(nowFrame - HorizonFrames);
                if (nowFrame - lastDurableFlushFrame < DurableFlushFrames) return;
                sink.Flush(toDisk: true);
                lastDurableFlushFrame = nowFrame;
            });
        }
    }

    // Commits everything up to the stop instant, horizon or not, and closes the audio file.
    public void Finish(long stopFrame)
    {
        lock (io)
        {
            if (closed) return;
            CloseOnFailure(() => Drain(stopFrame));
            closed = true;
            sink.CloseAudio();
        }
    }

    public void WriteSession(SessionDocument document)
    {
        lock (io) sink.WriteSession(document);
    }

    private void Drain(long throughFrame)
    {
        long drained = 0;
        int taken;
        while ((taken = mixer.TakeCommitted(throughFrame, chunk)) > 0)
        {
            sink.Append(chunk.AsSpan(0, taken * CallAudio.BytesPerFrame));
            drained += taken;
        }
        if (drained == 0) return;
        sink.Flush(toDisk: false);
        Interlocked.Add(ref committedFrames, drained);
    }

    // After one failed write the file's length no longer matches the timeline, so any later
    // append would shift every following frame. The loop closes for good instead.
    private void CloseOnFailure(Action write)
    {
        try { write(); }
        catch
        {
            closed = true;
            throw;
        }
    }

    public void Dispose()
    {
        lock (io)
        {
            closed = true;
            sink.Dispose();
        }
    }
}
