using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class CommitLoopTests
{
    [Fact]
    public void PumpCommitsOnlyPastTheLateAudioHorizon()
    {
        var mixer = new CallMixer();
        var sink = new MemorySink();
        using var loop = new CommitLoop(mixer, sink);

        loop.Pump(CommitLoop.HorizonFrames - 1);
        Assert.Equal(0, loop.CommittedFrames);

        loop.Pump(CommitLoop.HorizonFrames + 3200);
        Assert.Equal(3200, loop.CommittedFrames);
        Assert.Equal(3200 * CallAudio.BytesPerFrame, sink.Audio.Length);
    }

    [Fact]
    public void AudioLandingInsideTheHorizonIsCommittedInPlace()
    {
        var mixer = new CallMixer();
        var sink = new MemorySink();
        using var loop = new CommitLoop(mixer, sink);
        loop.Pump(20_000);
        // A packet for frame 10 000 arrives 0.6 s late, still inside the 1.5 s horizon.
        var placed = mixer.Add(CallAudio.ThemLane, 10_000, Enumerable.Repeat(0.5f, 160).ToArray());
        loop.Pump(40_000);

        Assert.Equal(0, placed.LateFrames);
        Assert.Equal((short)16384, Pcm.Frame(sink.Audio.ToArray(), 10_000).Them);
    }

    [Fact]
    public void FlushesToDiskEveryTwoSecondsOfTimeline()
    {
        var sink = new MemorySink();
        using var loop = new CommitLoop(new CallMixer(), sink);
        for (long frame = 0; frame <= CallAudio.SampleRate * 10; frame += CallAudio.SampleRate / 5) loop.Pump(frame);

        Assert.Equal(5, sink.DurableFlushes);
    }

    [Fact]
    public void FinishCommitsThroughTheStopInstantAndClosesTheAudio()
    {
        var mixer = new CallMixer();
        var sink = new MemorySink();
        using var loop = new CommitLoop(mixer, sink);
        mixer.Add(CallAudio.MeLane, 31_900, Enumerable.Repeat(0.25f, 100).ToArray());
        loop.Pump(32_000);

        loop.Finish(32_000);
        loop.Pump(64_000);

        Assert.Equal(32_000, loop.CommittedFrames);
        Assert.Equal(32_000 * CallAudio.BytesPerFrame, sink.Audio.Length);
        Assert.Equal((short)8192, Pcm.Frame(sink.Audio.ToArray(), 31_999).Me);
        Assert.True(sink.AudioClosed);
    }

    [Fact]
    public void AfterAWriteFailureNothingMoreIsAppended()
    {
        var sink = new MemorySink();
        using var loop = new CommitLoop(new CallMixer(), sink);
        loop.Pump(CommitLoop.HorizonFrames + 1000);
        sink.FailAppends = true;

        Assert.Throws<IOException>(() => loop.Pump(CommitLoop.HorizonFrames + 2000));
        sink.FailAppends = false;
        loop.Pump(CommitLoop.HorizonFrames + 3000);
        loop.Finish(CommitLoop.HorizonFrames + 4000);

        // The file stays a clean prefix of the timeline; a later append would have shifted it.
        Assert.Equal(1000, loop.CommittedFrames);
        Assert.Equal(1000 * CallAudio.BytesPerFrame, sink.Audio.Length);
    }

    [Fact]
    public void CatchesUpAfterALongStallInBoundedChunks()
    {
        var sink = new MemorySink();
        using var loop = new CommitLoop(new CallMixer(), sink);

        loop.Pump(CallAudio.SampleRate * 60);

        Assert.Equal(CallAudio.SampleRate * 60 - CommitLoop.HorizonFrames, loop.CommittedFrames);
    }
}
