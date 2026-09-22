using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.IO.Pipes;

namespace Kern.Recorder.Helper;

internal static partial class WindowsNative
{
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;

    [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    private static partial SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        nint securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        nint templateFile);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool FlushFileBuffers(SafeFileHandle fileHandle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetNamedPipeClientProcessId(SafePipeHandle pipeHandle, out uint clientProcessId);

    internal static bool IsNamedPipeClientProcess(NamedPipeServerStream pipe, int expectedProcessId) =>
        GetNamedPipeClientProcessId(pipe.SafePipeHandle, out var processId) && processId == expectedProcessId;

    internal static SafeFileHandle OpenDirectoryForFlush(string directory) =>
        CreateFile(
            directory,
            GenericRead,
            FileShareRead | FileShareWrite | FileShareDelete,
            0,
            OpenExisting,
            FileFlagBackupSemantics,
            0);

    // Windows Search opens freshly written files to index them, which races the
    // recorder's own atomic replaces. NTFS propagates the attribute to new children.
    private static void ExcludeFromContentIndexing(string directory)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            var attributes = File.GetAttributes(directory);
            if (!attributes.HasFlag(FileAttributes.NotContentIndexed))
                File.SetAttributes(directory, attributes | FileAttributes.NotContentIndexed);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    internal static void RestrictDirectoryToCurrentUser(string directory)
    {
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows()) return;
        ExcludeFromContentIndexing(directory);
        var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var security = new System.Security.AccessControl.DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(identity.User ?? throw new InvalidOperationException("Current Windows user has no SID."));
        security.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
            identity.User,
            System.Security.AccessControl.FileSystemRights.FullControl,
            System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
            System.Security.AccessControl.PropagationFlags.None,
            System.Security.AccessControl.AccessControlType.Allow));
        new DirectoryInfo(directory).SetAccessControl(security);
    }
}
