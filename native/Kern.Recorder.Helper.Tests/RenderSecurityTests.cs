using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class RenderSecurityTests
{
    [Theory]
    [InlineData("../outside.wav")]
    [InlineData("segments/../../outside.wav")]
    [InlineData("segments/evil.wav:stream")]
    [InlineData("/tmp/outside.wav")]
    [InlineData("segments/./x.wav")]
    [InlineData("segments/CON .wav")]
    public void RejectsHostileSourcePaths(string path)
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.2f); fixture.Save();
        Rewrite(fixture, node => node["segments"]![0]!["relativePath"] = path);
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
    }

    private static bool TryLink(Action create)
    {
        // Windows CI without Developer Mode denies symlink creation; treat as skip.
        try { create(); return true; }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException) { return false; }
    }

    [Fact]
    public void RejectsLinkedSourceAndDerivedDirectory()
    {
        using var fixture = new RenderFixture();
        var source = fixture.Add(0.2f); fixture.Save();
        var target = Path.Combine(fixture.Root, source.RelativePath);
        var held = target + ".original";
        File.Move(target, held);
        if (!TryLink(() => File.CreateSymbolicLink(target, held))) { File.Move(held, target); return; }
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
        File.Delete(target); File.Move(held, target);
        var other = Path.Combine(fixture.Root, "other");
        Directory.CreateDirectory(other);
        if (!TryLink(() => Directory.CreateSymbolicLink(Path.Combine(fixture.Root, "derived"), other))) return;
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
        Assert.Empty(Directory.GetFiles(other));
    }

    [Fact]
    public void RejectsLinkedSessionAncestor()
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.2f); fixture.Save();
        var alias = fixture.Root + "-alias";
        if (!TryLink(() => Directory.CreateSymbolicLink(alias, fixture.Root))) return;
        try
        {
            Assert.Throws<InvalidDataException>(() => CallRenderer.Render(alias));
        }
        finally { Directory.Delete(alias); }
    }

    [Fact]
    public void ConcurrentRendererLockPreventsPublishing()
    {
        using var fixture = new RenderFixture();
        fixture.Add(0.2f); fixture.Save();
        Directory.CreateDirectory(Path.Combine(fixture.Root, "derived"));
        using var renderLock = new FileStream(Path.Combine(fixture.Root, "derived", "render.lock"),
            FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        Assert.Throws<IOException>(() => CallRenderer.Render(fixture.Root));
        Assert.False(File.Exists(Path.Combine(fixture.Root, "derived", "manifest.json")));
    }

    [Fact]
    public void InvalidRiffSizeIsRejectedEvenWithCorrectChecksum()
    {
        using var fixture = new RenderFixture();
        var source = fixture.Add(0.2f); fixture.Save();
        var path = Path.Combine(fixture.Root, source.RelativePath);
        var bytes = File.ReadAllBytes(path);
        bytes[4] ^= 1;
        File.WriteAllBytes(path, bytes);
        Rewrite(fixture, node => node["segments"]![0]!["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
    }

    [Fact]
    public void NonfiniteFloatSamplesCannotPublishComplete()
    {
        using var fixture = new RenderFixture();
        fixture.Add(float.NaN, floating: true); fixture.Save();
        Assert.Throws<InvalidDataException>(() => CallRenderer.Render(fixture.Root));
        Assert.False(File.Exists(Path.Combine(fixture.Root, "derived", "manifest.json")));
    }

    private static void Rewrite(RenderFixture fixture, Action<JsonNode> change)
    {
        var manifest = Path.Combine(fixture.Root, "manifest.json");
        var node = JsonNode.Parse(File.ReadAllText(manifest))!;
        change(node);
        File.WriteAllText(manifest, node.ToJsonString());
    }
}
