using Kern.Recorder.Helper;
using NAudio.Wave;

namespace Kern.Recorder.Helper.Tests;

public sealed class WavValidatorTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"kern-recorder-test-{Guid.NewGuid():N}");

    public WavValidatorTests() => Directory.CreateDirectory(root);

    [Fact]
    public void AcceptsIndependentlyDecodableWaveFile()
    {
        var path = Path.Combine(root, "segment.wav");
        using (var writer = new WaveFileWriter(path, new WaveFormat(48_000, 16, 1)))
            writer.Write(new byte[9_600]);

        WavValidator.Validate(path, 9_600);
        using var reader = new WaveFileReader(path);
        Assert.Equal(9_600, reader.Length);
    }

    [Fact]
    public void RejectsTruncatedWaveFile()
    {
        var path = Path.Combine(root, "segment.wav");
        using (var writer = new WaveFileWriter(path, new WaveFormat(48_000, 16, 1)))
            writer.Write(new byte[9_600]);
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Write)) stream.SetLength(100);

        Assert.Throws<InvalidDataException>(() => WavValidator.Validate(path, 9_600));
    }

    public void Dispose() => Directory.Delete(root, recursive: true);
}
