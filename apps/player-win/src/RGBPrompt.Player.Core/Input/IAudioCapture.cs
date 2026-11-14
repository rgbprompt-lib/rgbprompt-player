namespace RGBPrompt.Player.Core.Input;

/// <summary>WASAPI loopback capture (M6-W3). Implementations live in the WinUI project.</summary>
public interface IAudioCapture : IDisposable
{
    bool IsRunning { get; }
    /// <summary>Raised on the capture thread with interleaved f32 PCM.</summary>
    event Action<float[], int /*frames*/, ushort /*channels*/, double /*rate*/>? SamplesAvailable;
    void Start();
    void Stop();
    /// <summary>Rebuild when the Windows default render device changes.</summary>
    void Rebuild();
}
