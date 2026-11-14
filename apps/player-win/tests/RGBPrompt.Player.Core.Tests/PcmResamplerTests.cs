using RGBPrompt.Player.Core.Input;

namespace RGBPrompt.Player.Core.Tests;

public class PcmResamplerTests
{
    [Fact]
    public void IdentityAt48k()
    {
        var resampler = new PcmResampler();
        var input = new float[] { 0.1f, -0.2f, 0.3f, -0.4f };
        var output = resampler.Resample(input, frames: 2, channels: 2, sampleRate: 48_000, out var frames);
        Assert.Equal(2, frames);
        Assert.Equal(input, output);
    }

    [Fact]
    public void RejectsInvalidArgs()
    {
        var resampler = new PcmResampler();
        Assert.Empty(resampler.Resample(new float[] { 1 }, 1, 0, 48_000, out var frames));
        Assert.Equal(0, frames);
        Assert.Empty(resampler.Resample(Array.Empty<float>(), 0, 1, 48_000, out frames));
        Assert.Equal(0, frames);
    }

    [Fact]
    public void DoublesRateFrom24kTo48k()
    {
        var resampler = new PcmResampler();
        // Two mono frames at 24 kHz should produce ~4 frames at 48 kHz.
        var input = new float[] { 0f, 1f };
        var output = resampler.Resample(input, frames: 2, channels: 1, sampleRate: 24_000, out var frames);
        Assert.True(frames >= 3, $"expected at least 3 frames, got {frames}");
        Assert.Equal(0f, output[0], precision: 5);
        // Mid-point between 0 and 1 is ~0.5
        Assert.True(output[1] is > 0.4f and < 0.6f, $"expected ~0.5, got {output[1]}");
    }

    [Fact]
    public void CarriesPhaseAcrossBuffers()
    {
        var resampler = new PcmResampler();
        // A 1 kHz sine at 44.1 kHz, two consecutive buffers, then 48 kHz output
        // should be continuous (no jump larger than a single step at the join).
        const int channels = 1;
        const double inRate = 44_100;
        const int buf = 256;
        float[] Render(int start)
        {
            var data = new float[buf];
            for (var i = 0; i < buf; i++)
            {
                var t = (start + i) / inRate;
                data[i] = (float)Math.Sin(2 * Math.PI * 1000 * t);
            }
            return data;
        }

        var first = resampler.Resample(Render(0), buf, channels, inRate, out var n1);
        var second = resampler.Resample(Render(buf), buf, channels, inRate, out var n2);
        Assert.True(n1 > 0 && n2 > 0);

        var joinA = first[^1];
        var joinB = second[0];
        var step = Math.Abs(joinB - joinA);
        // A 1 kHz sine at 48 kHz moves at most ~0.13 per sample; allow slack.
        Assert.True(step < 0.25f, $"discontinuity at buffer join: {joinA} -> {joinB} (step {step})");
    }
}
