using System.Diagnostics;
using System.Text.Json;

namespace Kern.Recorder.Helper;

internal static class AtomicFile
{
    // Windows rejects a replace with ERROR_ACCESS_DENIED or ERROR_SHARING_VIOLATION
    // while another process (a sync client, the search indexer, antivirus) briefly
    // holds the target open without FILE_SHARE_DELETE. Those holds clear within
    // milliseconds, so a bounded retry turns a spurious failure into a short stall.
    // A genuine permission problem still surfaces once the budget is spent.
    internal static readonly TimeSpan ReplaceBudget = TimeSpan.FromSeconds(2);
    private const int ErrorAccessDenied = 5;
    private const int ErrorSharingViolation = 32;
    private const int ErrorLockViolation = 33;

    public static void WriteJson<T>(string path, T value)
    {
        var directory = Path.GetDirectoryName(path) ?? throw new InvalidOperationException("Atomic path has no directory.");
        Directory.CreateDirectory(directory);
        var temporary = path + ".tmp";
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            JsonSerializer.Serialize(stream, value, Protocol.JsonOptions);
            stream.Flush(flushToDisk: true);
        }
        try { Retry(() => File.Move(temporary, path, overwrite: true), ReplaceBudget); }
        catch { DeleteBestEffort(temporary); throw; }
        FlushDirectoryBestEffort(directory);
    }

    private static void DeleteBestEffort(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    internal static void Retry(Action operation, TimeSpan budget)
    {
        var started = Stopwatch.GetTimestamp();
        var delay = 10;
        while (true)
        {
            try { operation(); return; }
            catch (Exception error) when (IsTransientReplaceFailure(error) && Stopwatch.GetElapsedTime(started) < budget)
            {
                Thread.Sleep(delay);
                delay = Math.Min(delay * 2, 250);
            }
        }
    }

    internal static bool IsTransientReplaceFailure(Exception error) =>
        error is UnauthorizedAccessException ||
        (error is IOException && (error.HResult & 0xFFFF) is ErrorAccessDenied or ErrorSharingViolation or ErrorLockViolation);

    private static void FlushDirectoryBestEffort(string directory)
    {
        if (!OperatingSystem.IsWindows()) return;
        using var handle = WindowsNative.OpenDirectoryForFlush(directory);
        if (!handle.IsInvalid) WindowsNative.FlushFileBuffers(handle);
    }
}
