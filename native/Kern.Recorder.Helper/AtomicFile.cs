using System.Text.Json;

namespace Kern.Recorder.Helper;

internal static class AtomicFile
{
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
        File.Move(temporary, path, overwrite: true);
        FlushDirectoryBestEffort(directory);
    }

    public static void AppendJournal(string path, object value)
    {
        var json = JsonSerializer.Serialize(value, Protocol.JsonOptions);
        using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
        using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false), 4096, leaveOpen: true);
        writer.WriteLine(json);
        writer.Flush();
        stream.Flush(flushToDisk: true);
    }

    public static void Publish(string temporaryPath, string finalPath)
    {
        using (var stream = new FileStream(temporaryPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None, 4096, FileOptions.WriteThrough))
            stream.Flush(flushToDisk: true);
        File.Move(temporaryPath, finalPath);
        FlushDirectoryBestEffort(Path.GetDirectoryName(finalPath)!);
    }

    public static void DeleteBestEffort(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void FlushDirectoryBestEffort(string directory)
    {
        if (!OperatingSystem.IsWindows()) return;
        using var handle = WindowsNative.OpenDirectoryForFlush(directory);
        if (!handle.IsInvalid) WindowsNative.FlushFileBuffers(handle);
    }
}
