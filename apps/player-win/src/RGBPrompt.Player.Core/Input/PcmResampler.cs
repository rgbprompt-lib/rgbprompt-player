namespace RGBPrompt.Player.Core.Input;

/// <summary>
/// Converts interleaved f32 PCM to 48 kHz, the rate the v15 KeyboardAgent
/// analyser assumes (FFT 2048 / hop 512 ≈ 42.7 ms window). Identity copy when
/// the source is already 48 kHz. Linear interpolation with a carried
/// fractional phase so successive buffers stay continuous.
/// </summary>
public sealed class PcmResampler
{
    public const double TargetRate = 48_000.0;

    // Input-frame position of the next output frame, relative to the start of
    // the current buffer. After each buffer it is reduced by `frames` so a
    // leftover in (-1, 1) carries into the next call.
    double _position;
    float[] _prev = Array.Empty<float>();
    bool _hasPrev;
    int _channels = 1;

    public static bool IsTargetRate(double sampleRate) =>
        sampleRate > 0 && Math.Abs(sampleRate - TargetRate) < 0.5;

    public void Reset()
    {
        _position = 0;
        _hasPrev = false;
    }

    /// <summary>
    /// Resample interleaved PCM from <paramref name="sampleRate"/> to 48 kHz.
    /// The returned array is owned by the caller. <paramref name="outputFrames"/>
    /// is the number of frames in that array.
    /// </summary>
    public float[] Resample(
        ReadOnlySpan<float> input,
        int frames,
        int channels,
        double sampleRate,
        out int outputFrames)
    {
        outputFrames = 0;
        if (channels < 1 || frames <= 0 || sampleRate <= 0)
            return Array.Empty<float>();

        var sampleCount = frames * channels;
        if (input.Length < sampleCount)
            return Array.Empty<float>();

        if (channels != _channels)
        {
            _channels = channels;
            _prev = new float[channels];
            _hasPrev = false;
            _position = 0;
        }

        if (IsTargetRate(sampleRate))
        {
            _position = 0;
            _hasPrev = false;
            outputFrames = frames;
            var exact = new float[sampleCount];
            input.Slice(0, sampleCount).CopyTo(exact);
            return exact;
        }

        var step = sampleRate / TargetRate;
        var estimate = (int)Math.Ceiling(frames * TargetRate / sampleRate) + 2;
        var output = new float[estimate * channels];
        var written = 0;

        while (true)
        {
            var index = (int)Math.Floor(_position);
            var frac = (float)(_position - index);

            if (index >= frames - 1)
            {
                // Need the first frame of the next buffer to interpolate the
                // last input frame, unless we landed exactly on it.
                if (index == frames - 1 && frac == 0f)
                {
                    WriteFrame(output, written, input, index, channels);
                    written++;
                    _position += step;
                    continue;
                }
                break;
            }

            if (index < 0)
            {
                if (!_hasPrev)
                {
                    _position += step;
                    continue;
                }
                // Interpolate previous buffer's last frame → input[0].
                var t = (float)(_position + 1);
                if (t < 0) t = 0;
                if (t > 1) t = 1;
                var dest = written * channels;
                Ensure(ref output, dest + channels);
                for (var c = 0; c < channels; c++)
                    output[dest + c] = _prev[c] + (input[c] - _prev[c]) * t;
                written++;
                _position += step;
                continue;
            }

            {
                var dest = written * channels;
                Ensure(ref output, dest + channels);
                var a = index * channels;
                var b = a + channels;
                for (var c = 0; c < channels; c++)
                {
                    var s0 = input[a + c];
                    var s1 = input[b + c];
                    output[dest + c] = s0 + (s1 - s0) * frac;
                }
                written++;
                _position += step;
            }
        }

        var last = (frames - 1) * channels;
        if (_prev.Length != channels)
            _prev = new float[channels];
        for (var c = 0; c < channels; c++)
            _prev[c] = input[last + c];
        _hasPrev = true;
        _position -= frames;

        outputFrames = written;
        if (written * channels == output.Length)
            return output;
        var trimmed = new float[written * channels];
        output.AsSpan(0, trimmed.Length).CopyTo(trimmed);
        return trimmed;
    }

    static void WriteFrame(float[] output, int frame, ReadOnlySpan<float> input, int index, int channels)
    {
        Ensure(ref output, (frame + 1) * channels);
        input.Slice(index * channels, channels).CopyTo(output.AsSpan(frame * channels, channels));
    }

    static void Ensure(ref float[] buffer, int needed)
    {
        if (buffer.Length >= needed) return;
        var grown = new float[Math.Max(needed, buffer.Length * 2)];
        buffer.CopyTo(grown, 0);
        buffer = grown;
    }
}
