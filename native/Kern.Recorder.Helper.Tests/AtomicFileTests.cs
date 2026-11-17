using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class AtomicFileTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "kern-atomic-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void RetryRecoversFromTransientReplaceFailures()
    {
        var attempts = 0;
        AtomicFile.Retry(() =>
        {
            if (++attempts < 3) throw new UnauthorizedAccessException("Access to the path is denied.");
        }, TimeSpan.FromSeconds(2));
        Assert.Equal(3, attempts);
    }

    [Fact]
    public void RetryGivesUpAfterItsBudget()
    {
        var attempts = 0;
        Assert.Throws<UnauthorizedAccessException>(() => AtomicFile.Retry(() =>
        {
            attempts++;
            throw new UnauthorizedAccessException("Access to the path is denied.");
        }, TimeSpan.FromMilliseconds(80)));
        Assert.True(attempts >= 2);
    }

    [Fact]
    public void RetryDoesNotMaskNonTransientFailures()
    {
        var attempts = 0;
        Assert.Throws<InvalidDataException>(() => AtomicFile.Retry(() =>
        {
            attempts++;
            throw new InvalidDataException("corrupt");
        }, TimeSpan.FromSeconds(2)));
        Assert.Equal(1, attempts);
    }

    [Fact]
    public void SharingAndLockViolationsAreTransientButMissingFilesAreNot()
    {
        Assert.True(AtomicFile.IsTransientReplaceFailure(new IOException("sharing", unchecked((int)0x80070020))));
        Assert.True(AtomicFile.IsTransientReplaceFailure(new IOException("lock", unchecked((int)0x80070021))));
        Assert.True(AtomicFile.IsTransientReplaceFailure(new UnauthorizedAccessException()));
        Assert.False(AtomicFile.IsTransientReplaceFailure(new IOException("missing", unchecked((int)0x80070002))));
        Assert.False(AtomicFile.IsTransientReplaceFailure(new FileNotFoundException()));
    }

    [Fact]
    public void WriteJsonLeavesNoTemporaryFileWhenTheReplaceFails()
    {
        var path = Path.Combine(root, "manifest.json");
        Directory.CreateDirectory(path);
        Assert.ThrowsAny<Exception>(() => AtomicFile.WriteJson(path, new { value = 1 }));
        Assert.False(File.Exists(path + ".tmp"));
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}
