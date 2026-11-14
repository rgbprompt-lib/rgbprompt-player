using Microsoft.UI.Xaml;
using RGBPrompt.Player.Core.Input;
using RGBPrompt.Player.Core.Interop;
using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player.Input;

/// <summary>
/// Installs WASAPI loopback and the low-level keyboard hook only while the
/// core is Playing and wants that input (same contract as the Mac
/// <c>InputCoordinator</c>). Play/push never reveals the panel.
/// </summary>
public sealed class InputCoordinator : IDisposable
{
    public const string DisableCaptureEnvironment = "RGBP_DISABLE_INPUT_CAPTURE";

    readonly PlayerCoreBridge _bridge;
    readonly IAudioCapture _audio;
    readonly IKeyCapture _keys;
    readonly DispatcherTimer _timer;
    readonly bool _captureDisabled;

    bool _audioEnabled = true;
    bool _keyEnabled = true;
    bool _wantsAudio;
    bool _wantsKeys;
    bool _effectWantsAudio;
    bool _effectWantsKeys;
    PanelState _lastState = new PanelState.Idle(null);
    bool _disposed;

    public float Level { get; private set; }
    public bool EffectWantsAudio => _effectWantsAudio;
    public bool EffectWantsKeys => _effectWantsKeys;
    public bool AudioEnabled => _audioEnabled;
    public bool KeyEnabled => _keyEnabled;
    public event Action? Changed;

    public InputCoordinator(
        PlayerCoreBridge bridge,
        IAudioCapture audio,
        IKeyCapture keys,
        bool? captureDisabled = null)
    {
        _bridge = bridge;
        _audio = audio;
        _keys = keys;
        _captureDisabled = captureDisabled
            ?? string.Equals(
                Environment.GetEnvironmentVariable(DisableCaptureEnvironment),
                "1",
                StringComparison.Ordinal);

        _audio.SamplesAvailable += OnSamples;
        _keys.KeyEvent += OnKey;

        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
        _timer.Tick += (_, _) => Reconcile();
    }

    public void Start()
    {
        if (_disposed) return;
        if (!_timer.IsEnabled)
            _timer.Start();
        Reconcile();
    }

    public void Update(PanelState state)
    {
        _lastState = state;
        Reconcile();
    }

    public void SetAudioEnabled(bool enabled)
    {
        if (_audioEnabled == enabled) return;
        _audioEnabled = enabled;
        Reconcile();
    }

    public void SetKeyReactiveEnabled(bool enabled)
    {
        if (_keyEnabled == enabled) return;
        _keyEnabled = enabled;
        Reconcile();
    }

    void Reconcile()
    {
        if (_disposed) return;
        var wanted = (InputWants)_bridge.InputWanted();
        var playing = _lastState.IsPlaying && !_captureDisabled;

        _effectWantsAudio = playing && wanted.HasFlag(InputWants.Audio);
        _effectWantsKeys = playing && wanted.HasFlag(InputWants.Keys);
        _wantsAudio = _effectWantsAudio && _audioEnabled;
        _wantsKeys = _effectWantsKeys && _keyEnabled;
        if (!_wantsAudio) Level = 0;
        Changed?.Invoke();

        if (_wantsAudio)
            StartAudio();
        else
            StopAudio();

        if (_wantsKeys)
            StartKeys();
        else
            StopKeys();
    }

    void StartAudio()
    {
        if (_audio.IsRunning) return;
        try
        {
            _audio.Start();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"audio_capture failed: {ex.GetType().Name}");
        }
    }

    void StopAudio()
    {
        if (!_audio.IsRunning) return;
        _audio.Stop();
    }

    void StartKeys()
    {
        if (_keys.IsRunning) return;
        _keys.Start();
    }

    void StopKeys()
    {
        if (!_keys.IsRunning) return;
        _keys.Stop();
    }

    void OnSamples(float[] samples, int frames, ushort channels, double rate)
    {
        _ = _bridge.PushAudio(samples, frames, channels, rate);
        var peak = 0f;
        for (var i = 0; i < samples.Length; i++)
        {
            var a = Math.Abs(samples[i]);
            if (a > peak) peak = a;
        }
        Level = peak;
    }

    void OnKey(string name, bool down)
    {
        // Never log the key name or down/up.
        _ = _bridge.PushKey(name, down);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _timer.Stop();
        _audio.SamplesAvailable -= OnSamples;
        _keys.KeyEvent -= OnKey;
        StopAudio();
        StopKeys();
        _audio.Dispose();
        _keys.Dispose();
    }
}
