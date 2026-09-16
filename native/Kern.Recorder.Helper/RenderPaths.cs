using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace Kern.Recorder.Helper;

// Directory handles deny rename/delete during rendering on Windows.
internal sealed partial class RenderPaths : IDisposable
{
    private readonly List<SafeFileHandle> directoryHandles = [];
    private readonly HashSet<string> pinned = new(StringComparer.OrdinalIgnoreCase);
    public string Root { get; }

    public RenderPaths(string directory)
    {
        if (!Path.IsPathFullyQualified(directory)) throw new InvalidDataException("Render needs an absolute session path.");
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
        try { PinDirectory(Root); }
        catch { Dispose(); throw; }
    }

    public string Resolve(string relative)
    {
        var parts = relative.Replace('\\', '/').Split('/');
        if (parts.Length == 0 || parts.Any(part => part.Length == 0 || part is "." or ".." ||
            part.EndsWith('.') || IsDeviceName(part) ||
            part.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_' and not '.')))
            throw new InvalidDataException("Invalid render-relative path.");
        var path = Path.Combine(Root, Path.Combine(parts));
        PinDirectory(Path.GetDirectoryName(path)!);
        RejectLink(path);
        return path;
    }

    public void CreateDirectory(string relative)
    {
        var path = Resolve(relative);
        Directory.CreateDirectory(path);
        PinDirectory(path);
    }

    public FileStream OpenRead(string relative)
    {
        var path = Resolve(relative);
        FileStream stream;
        if (OperatingSystem.IsWindows())
        {
            var handle = OpenDirectory(path, 0x80000000, 1, 0, 3, 0x00200000, 0);
            if (handle.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                // Translate a missing file to the managed IOException family so callers
                // that treat "not found" as a cache miss behave the same as on POSIX.
                if (error is 2 or 3) throw new FileNotFoundException("Render input was not found.", path);
                throw new Win32Exception(error);
            }
            try
            {
                if (!GetFileInformationByHandle(handle, out var info)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if ((info.Attributes & (uint)(FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || info.Links != 1)
                    throw new InvalidDataException("Source must be a regular, non-linked file.");
                stream = new FileStream(handle, FileAccess.Read);
            }
            catch { handle.Dispose(); throw; }
        }
        else stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try { RejectLink(path); return stream; }
        catch { stream.Dispose(); throw; }
    }

    public string Hash(string relative)
    {
        using var stream = OpenRead(relative);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    public byte[] ReadBytes(string relative, int maximum)
    {
        using var stream = OpenRead(relative);
        if (stream.Length > maximum) throw new InvalidDataException("Manifest exceeds render limit.");
        var bytes = new byte[checked((int)stream.Length)];
        stream.ReadExactly(bytes);
        return bytes;
    }

    public void Publish(string temporary, string destination)
    {
        File.Move(Resolve(temporary), Resolve(destination), overwrite: true);
    }

    private void PinDirectory(string path)
    {
        if (pinned.Contains(path)) return;
        var parent = Path.GetDirectoryName(path);
        if (parent is not null && parent != path) PinDirectory(parent);
        RejectLink(path);
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException(path);
        if (OperatingSystem.IsWindows())
        {
            var handle = OpenDirectory(path, 0, 3, 0, 3, 0x02200000, 0);
            if (handle.IsInvalid) { handle.Dispose(); throw new Win32Exception(Marshal.GetLastWin32Error()); }
            directoryHandles.Add(handle);
            if (!GetFileInformationByHandle(handle, out var info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((info.Attributes & (uint)FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Reparse directories are forbidden for rendering.");
        }
        RejectLink(path);
        pinned.Add(path);
    }

    private static bool IsDeviceName(string part)
    {
        var name = part.Split('.')[0].ToUpperInvariant();
        return name is "CON" or "PRN" or "AUX" or "NUL" ||
            (name.Length == 4 && (name.StartsWith("COM", StringComparison.Ordinal) || name.StartsWith("LPT", StringComparison.Ordinal)) &&
             name[3] is >= '1' and <= '9');
    }

    private static void RejectLink(string path)
    {
        FileSystemInfo info = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);
        if (info.LinkTarget is not null || (info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0))
            throw new InvalidDataException("Symlinks and reparse points are forbidden for rendering.");
    }

    public void Dispose()
    {
        foreach (var handle in directoryHandles.AsEnumerable().Reverse()) handle.Dispose();
        directoryHandles.Clear();
    }

    [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle OpenDirectory(string name, uint access, uint share, nint security,
        uint disposition, uint flags, nint template);
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        public uint Attributes;
        public uint CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
}
