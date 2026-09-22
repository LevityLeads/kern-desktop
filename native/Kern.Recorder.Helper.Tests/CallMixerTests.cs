using Kern.Recorder.Helper;

namespace Kern.Recorder.Helper.Tests;

public sealed class CallMixerTests
{
    [Fact]
    public void SumsOverlappingAudioPerLaneAndKeepsLanesApart()
    {
        var mixer = new CallMixer(1000);
        mixer.Add(CallAudio.MeLane, 0, Filled(10, 0.25f));
        mixer.Add(CallAudio.MeLane, 5, Filled(10, 0.25f));
        mixer.Add(CallAudio.ThemLane, 0, Filled(3, -0.5f));

        var audio = Take(mixer, 20);

        Assert.Equal(((short)8192, (short)-16384), Pcm.Frame(audio, 0));
        Assert.Equal(((short)16384, (short)0), Pcm.Frame(audio, 5));
        Assert.Equal(((short)8192, (short)0), Pcm.Frame(audio, 14));
        Assert.Equal(((short)0, (short)0), Pcm.Frame(audio, 15));
    }

    [Fact]
    public void ClampsSumsToInt16()
    {
        var mixer = new CallMixer(100);
        mixer.Add(CallAudio.MeLane, 0, [0.8f, -0.8f]);
        mixer.Add(CallAudio.MeLane, 0, [0.8f, -0.8f]);

        var audio = Take(mixer, 2);

        Assert.Equal(short.MaxValue, Pcm.Frame(audio, 0).Me);
        Assert.Equal(short.MinValue, Pcm.Frame(audio, 1).Me);
    }

    [Fact]
    public void LateAudioIsShiftedToTheCommittedEdgeNotDropped()
    {
        var mixer = new CallMixer(100);
        Take(mixer, 50);

        var result = mixer.Add(CallAudio.ThemLane, 40, Filled(20, 0.5f));

        Assert.Equal(new MixResult(50, 10, 0), result);
        var audio = Take(mixer, 80);
        Assert.Equal((short)16384, Pcm.Frame(audio, 0).Them);
        Assert.Equal((short)16384, Pcm.Frame(audio, 19).Them);
        Assert.Equal((short)0, Pcm.Frame(audio, 20).Them);
    }

    [Fact]
    public void AudioBeyondTheRingIsDroppedAndCounted()
    {
        var mixer = new CallMixer(100);

        var result = mixer.Add(CallAudio.MeLane, 90, Filled(30, 0.5f));

        Assert.Equal(new MixResult(90, 0, 20), result);
        var audio = Take(mixer, 120);
        Assert.Equal((short)16384, Pcm.Frame(audio, 99).Me);
        Assert.Equal((short)0, Pcm.Frame(audio, 100).Me);
    }

    [Fact]
    public void WrapsAroundTheRingAcrossManyCommits()
    {
        var mixer = new CallMixer(64);
        for (var round = 0; round < 20; round++)
        {
            var start = round * 50L;
            mixer.Add(CallAudio.MeLane, start, Filled(50, (round + 1) / 100f));
            var audio = Take(mixer, start + 50);
            Assert.Equal(200, audio.Length);
            var expected = (short)MathF.Round((round + 1) / 100f * 32768f);
            for (var frame = 0; frame < 50; frame++) Assert.Equal(expected, Pcm.Frame(audio, frame).Me);
        }
    }

    [Fact]
    public void GatesSilenceExactlyTheirSpanOnTheirLanes()
    {
        var mixer = new CallMixer(1000);
        mixer.Add(CallAudio.MeLane, 0, Filled(300, 0.5f));
        mixer.Add(CallAudio.ThemLane, 0, Filled(300, 0.5f));
        // Mute covers [100, 150) on "me" only, pause covers [200, 250) on both.
        var mute = mixer.OpenGate(CallMixer.MeMask, 100);
        var pause = mixer.OpenGate(CallMixer.BothMask, 200);
        mixer.CloseGate(mute, 150);
        mixer.CloseGate(pause, 250);

        var audio = Take(mixer, 300);

        Assert.Equal(((short)16384, (short)16384), Pcm.Frame(audio, 99));
        Assert.Equal(((short)0, (short)16384), Pcm.Frame(audio, 100));
        Assert.Equal(((short)0, (short)16384), Pcm.Frame(audio, 149));
        Assert.Equal(((short)16384, (short)16384), Pcm.Frame(audio, 150));
        Assert.Equal(((short)0, (short)0), Pcm.Frame(audio, 200));
        Assert.Equal(((short)0, (short)0), Pcm.Frame(audio, 249));
        Assert.Equal(((short)16384, (short)16384), Pcm.Frame(audio, 250));
    }

    [Fact]
    public void AnOpenGateSilencesAudioThatArrivesLateAcrossCommits()
    {
        var mixer = new CallMixer(1000);
        var gate = mixer.OpenGate(CallMixer.MeMask, 50);
        mixer.Add(CallAudio.MeLane, 0, Filled(100, 0.5f));
        var first = Take(mixer, 100);
        mixer.Add(CallAudio.MeLane, 100, Filled(100, 0.5f));
        mixer.CloseGate(gate, 150);
        var second = Take(mixer, 200);

        Assert.Equal((short)16384, Pcm.Frame(first, 49).Me);
        Assert.Equal((short)0, Pcm.Frame(first, 50).Me);
        Assert.Equal((short)0, Pcm.Frame(second, 49).Me);
        Assert.Equal((short)16384, Pcm.Frame(second, 50).Me);
    }

    [Fact]
    public void TakeCommittedHonoursTheDestinationSize()
    {
        var mixer = new CallMixer(1000);
        var buffer = new byte[40];

        Assert.Equal(10, mixer.TakeCommitted(25, buffer));
        Assert.Equal(10, mixer.TakeCommitted(25, buffer));
        Assert.Equal(5, mixer.TakeCommitted(25, buffer));
        Assert.Equal(0, mixer.TakeCommitted(25, buffer));
        Assert.Equal(1, mixer.TakeCommitted(26, buffer));
    }

    private static float[] Filled(int count, float value) => Enumerable.Repeat(value, count).ToArray();

    private static byte[] Take(CallMixer mixer, long through)
    {
        var output = new MemoryStream();
        var buffer = new byte[64];
        int taken;
        while ((taken = mixer.TakeCommitted(through, buffer)) > 0) output.Write(buffer, 0, taken * CallAudio.BytesPerFrame);
        return output.ToArray();
    }
}
