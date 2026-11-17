using System.Text.Json;
using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class MicWatchTests
{
    private sealed class FakeEndpoint(Func<IReadOnlyList<MicSession>> read) : IMicEndpoint
    {
        public bool Disposed { get; private set; }
        public IReadOnlyList<MicSession> ActiveSessions() => read();
        public void Dispose() => Disposed = true;
    }

    private sealed class FakeSource(Func<IReadOnlyList<IMicEndpoint>> endpoints) : IMicSessionSource
    {
        public IReadOnlyList<IMicEndpoint> Endpoints() => endpoints();
    }

    private sealed class Rig
    {
        public List<MicSession> Sessions { get; } = [];
        public List<string> Lines { get; } = [];
        public long Now { get; set; } = 1_000;
        public MicWatch Watch { get; }

        public Rig(params int[] excluded)
        {
            Watch = new MicWatch(
                new FakeSource(() => new IMicEndpoint[] { new FakeEndpoint(() => Sessions.ToList()) }),
                excluded, Lines.Add, () => Now);
        }
    }

    private static string[] Names(string line) =>
        JsonDocument.Parse(line).RootElement.GetProperty("apps").EnumerateArray()
            .Select(app => $"{app.GetProperty("pid").GetInt32()}:{app.GetProperty("name").GetString()}").ToArray();

    [Fact]
    public void EmitsTheDocumentedShape()
    {
        var rig = new Rig();
        rig.Sessions.Add(new MicSession(1234, "ms-teams"));
        rig.Watch.Poll();
        Assert.Equal("""{"type":"mic","apps":[{"pid":1234,"name":"ms-teams"}]}""", Assert.Single(rig.Lines));
    }

    [Fact]
    public void EmitsOnChangeOnly()
    {
        var rig = new Rig();
        rig.Watch.Poll();
        rig.Now += 1_000;
        rig.Watch.Poll();
        Assert.Single(rig.Lines);
        rig.Sessions.Add(new MicSession(10, "zoom"));
        rig.Now += 1_000;
        rig.Watch.Poll();
        rig.Now += 1_000;
        rig.Watch.Poll();
        Assert.Equal(2, rig.Lines.Count);
        Assert.Equal(new[] { "10:zoom" }, Names(rig.Lines[1]));
        rig.Sessions.Clear();
        rig.Now += 1_000;
        rig.Watch.Poll();
        Assert.Equal(3, rig.Lines.Count);
        Assert.Empty(Names(rig.Lines[2]));
    }

    [Fact]
    public void ExcludesOwnAndParentPid()
    {
        var rig = new Rig(111, 222);
        rig.Sessions.AddRange([new MicSession(111, "kern.recorder.helper"), new MicSession(222, "kern"), new MicSession(333, "zoom")]);
        rig.Watch.Poll();
        Assert.Equal(new[] { "333:zoom" }, Names(Assert.Single(rig.Lines)));
    }

    [Fact]
    public void HeartbeatsAfterThirtySecondsWithoutChange()
    {
        var rig = new Rig();
        rig.Sessions.Add(new MicSession(5, "chrome"));
        rig.Watch.Poll();
        rig.Now += MicWatch.HeartbeatMs - 1;
        rig.Watch.Poll();
        Assert.Single(rig.Lines);
        rig.Now += 1;
        rig.Watch.Poll();
        Assert.Equal(2, rig.Lines.Count);
        Assert.Equal(new[] { "5:chrome" }, Names(rig.Lines[1]));
    }

    [Fact]
    public void OneFailingEndpointDoesNotDropTheOthers()
    {
        var good = new FakeEndpoint(() => [new MicSession(7, "msedge")]);
        var bad = new FakeEndpoint(() => throw new InvalidOperationException("device gone"));
        var lines = new List<string>();
        var watch = new MicWatch(new FakeSource(() => new IMicEndpoint[] { bad, good }), [], lines.Add, () => 0);
        watch.Poll();
        Assert.Equal(new[] { "7:msedge" }, Names(Assert.Single(lines)));
        Assert.True(bad.Disposed);
        Assert.True(good.Disposed);
    }

    [Fact]
    public void WholePassFailureEmitsOneErrorAndRecovers()
    {
        var broken = true;
        var lines = new List<string>();
        long now = 0;
        var watch = new MicWatch(
            new FakeSource(() =>
            {
                if (broken) throw new InvalidOperationException("no enumerator");
                return new IMicEndpoint[] { new FakeEndpoint(() => []) };
            }),
            [], lines.Add, () => now);
        watch.Poll();
        now += 1_000;
        watch.Poll();
        Assert.Equal("""{"type":"error","code":"enumerate-failed"}""", Assert.Single(lines));
        broken = false;
        now += 1_000;
        watch.Poll();
        Assert.Equal(2, lines.Count);
        Assert.Empty(Names(lines[1]));
    }
}
