namespace Kern.Recorder.Helper;

// Where a session's bytes go. The file implementation is CallWriter; tests substitute memory.
internal interface ICallSink : IDisposable
{
    void Append(ReadOnlySpan<byte> frames);
    // toDisk=false hands buffered bytes to the OS so a concurrent reader sees them; true also
    // forces them to stable storage.
    void Flush(bool toDisk);
    void CloseAudio();
    void WriteSession(SessionDocument document);
}

// audio.pcm is append-only and readable while recording (the desktop cuts upload windows from
// it live); session.json is replaced atomically so a reader never sees a torn document.
internal sealed class CallWriter : ICallSink
{
    public const string AudioFileName = "audio.pcm";
    public const string SessionFileName = "session.json";

    private readonly string sessionPath;
    private FileStream? audio;

    public CallWriter(string sessionPath)
    {
        this.sessionPath = sessionPath;
        audio = new FileStream(Path.Combine(sessionPath, AudioFileName), FileMode.CreateNew, FileAccess.Write,
            FileShare.Read | FileShare.Delete, 64 * 1024, FileOptions.SequentialScan);
    }

    public void Append(ReadOnlySpan<byte> frames) => Audio.Write(frames);

    public void Flush(bool toDisk) => Audio.Flush(toDisk);

    public void CloseAudio()
    {
        var stream = audio;
        if (stream is null) return;
        audio = null;
        try { stream.Flush(flushToDisk: true); }
        finally { stream.Dispose(); }
    }

    public void WriteSession(SessionDocument document) =>
        AtomicFile.WriteJson(Path.Combine(sessionPath, SessionFileName), document);

    private FileStream Audio => audio ?? throw new ObjectDisposedException(AudioFileName);

    public void Dispose()
    {
        // Disposal after a write failure must not throw again; the failure is already reported.
        try { audio?.Dispose(); }
        catch (IOException) { }
        audio = null;
    }
}
