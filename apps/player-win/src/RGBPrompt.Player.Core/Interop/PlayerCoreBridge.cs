using System.Runtime.InteropServices;
using System.Text;
using RGBPrompt.Player.Core.Models;
using RGBPrompt.Player.Core.Services;

namespace RGBPrompt.Player.Core.Interop;

/// <summary>
/// Owns the C core handle and republishes state. The state callback runs on the
/// core control thread; strings are copied into <see cref="CoreStateEvent"/>
/// before hopping to <see cref="SynchronizationContext"/> (WinUI DispatcherQueue).
/// </summary>
public sealed class PlayerCoreBridge : IDisposable
{
    readonly BridgeConfig _config;
    readonly SynchronizationContext? _sync;
    readonly NativeMethods.RgbpStateCallback _callback;
    IntPtr _handle;
    List<IntPtr> _pinned = new();
    string? _localFileName;

    public event Action<CoreStateEvent>? StateChanged;

    public PanelState State { get; private set; } = new PanelState.Idle(null);
    public string EffectName { get; private set; } = "";
    public string KeyboardName { get; private set; } = "";
    public KeyboardSupport KeyboardSupport { get; private set; } = KeyboardSupport.Unknown;
    public uint Fps { get; private set; }
    public int? DriverProgress { get; private set; }
    public FailureCode? LastFailure { get; private set; }
    public string? ConflictName { get; private set; }
    public bool StoppedByUser { get; private set; }
    public PlaySource PlaySource { get; private set; } = new PlaySource.None();
    public BridgeConfig Config => _config;
    public string Language { get; private set; }
    public bool IsCoreAvailable => _handle != IntPtr.Zero;

    public PlayerCoreBridge(BridgeConfig config, SynchronizationContext? sync = null)
    {
        _config = config;
        Language = config.Language;
        _sync = sync ?? SynchronizationContext.Current;
        _callback = OnNativeState;

        if (NativeMethods.rgbp_abi_version() != NativeMethods.AbiVersion)
        {
            State = new PanelState.CoreUnavailable();
            return;
        }

        Directory.CreateDirectory(config.DataDir);
        var native = BuildConfig(config);
        _handle = NativeMethods.rgbp_create(in native);
        if (_handle == IntPtr.Zero)
        {
            State = new PanelState.CoreUnavailable();
            FreePinned();
            return;
        }

        var rc = NativeMethods.rgbp_set_state_callback(_handle, _callback, IntPtr.Zero);
        if (rc != NativeMethods.Ok)
        {
            NativeMethods.rgbp_destroy(_handle);
            _handle = IntPtr.Zero;
            State = new PanelState.CoreUnavailable();
            FreePinned();
        }
    }

    /// <summary>Test / offline constructor that never touches the native DLL.</summary>
    public PlayerCoreBridge(PanelState previewState, BridgeConfig? config = null)
    {
        _config = config ?? new BridgeConfig(
            Path.GetTempPath(),
            BridgeConfigBuilder.ProductionApiBase,
            "en",
            "0.0.0",
            "10.0.0",
            null);
        _sync = null;
        _callback = OnNativeState;
        Language = _config.Language;
        State = previewState;
        _handle = IntPtr.Zero;
    }

    void OnNativeState(IntPtr ev, IntPtr user)
    {
        if (ev == IntPtr.Zero) return;
        var native = Marshal.PtrToStructure<NativeMethods.RgbpStateEvent>(ev);
        var copied = new CoreStateEvent(
            State: native.State,
            Error: native.Error,
            EffectName: PtrToString(native.EffectName),
            KeyboardName: PtrToString(native.KeyboardName),
            KeyboardSupport: native.KeyboardSupport,
            Fps: native.Fps,
            DriverProgress: native.DriverProgress,
            DriverError: native.DriverError,
            ConflictName: PtrToStringOrNull(native.ConflictName));

        void Apply()
        {
            ApplyEvent(copied);
            StateChanged?.Invoke(copied);
        }

        if (_sync != null) _sync.Post(_ => Apply(), null);
        else Apply();
    }

    void ApplyEvent(CoreStateEvent ev)
    {
        State = PanelState.FromEvent(ev);
        EffectName = string.IsNullOrEmpty(ev.EffectName) && _localFileName != null ? _localFileName : ev.EffectName;
        KeyboardName = ev.KeyboardName;
        KeyboardSupport = KeyboardSupportExtensions.FromCode(ev.KeyboardSupport);
        Fps = ev.Fps;
        DriverProgress = ev.DriverProgress >= 0 ? ev.DriverProgress : null;
        ConflictName = ev.ConflictName;
        if (ev.Error != 0)
            LastFailure = FailureCodeExtensions.FromCode(ev.Error);
        if (State is PanelState.Playing)
            StoppedByUser = false;
    }

    public BridgeError? OpenUrl(string url)
    {
        if (_handle == IntPtr.Zero) return new BridgeError.CoreUnavailable();
        LastFailure = null;
        _localFileName = null;
        StoppedByUser = false;
        PlaySource = new PlaySource.Web();
        return BridgeError.From(NativeMethods.rgbp_open_url(_handle, url));
    }

    public BridgeError? OpenLepFile(string path, string? presetId = null)
    {
        if (_handle == IntPtr.Zero) return new BridgeError.CoreUnavailable();
        LastFailure = null;
        StoppedByUser = false;
        PlaySource = presetId != null ? new PlaySource.Preset(presetId) : new PlaySource.File();
        _localFileName = Path.GetFileNameWithoutExtension(path);
        return BridgeError.From(NativeMethods.rgbp_open_lep_file(_handle, path));
    }

    public BridgeError? Stop()
    {
        if (_handle == IntPtr.Zero) return new BridgeError.CoreUnavailable();
        if (State.IsPlaying) StoppedByUser = true;
        return BridgeError.From(NativeMethods.rgbp_stop(_handle));
    }

    public BridgeError? Retry() =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable() : BridgeError.From(NativeMethods.rgbp_retry(_handle));

    public BridgeError? InstallDriver() =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable() : BridgeError.From(NativeMethods.rgbp_install_driver(_handle));

    /// <summary>Replaces the embedded OpenRGB manifest (Debug dev override only).</summary>
    public BridgeError? SetDriverManifest(string json) =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable() : BridgeError.From(NativeMethods.rgbp_set_driver_manifest_json(_handle, json));

    public BridgeError? RestartBackend() =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable() : BridgeError.From(NativeMethods.rgbp_restart_backend(_handle));

    public BridgeError? NotifyDevicesChanged() =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable() : BridgeError.From(NativeMethods.rgbp_notify_devices_changed(_handle));

    public BridgeError? SetBrightness(int brightness) =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable()
            : BridgeError.From(NativeMethods.rgbp_set_brightness(_handle, (byte)Math.Clamp(brightness, 0, 100)));

    public BridgeError? SetLanguage(string language)
    {
        Language = language.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? "zh-CN" : "en";
        return _handle == IntPtr.Zero
            ? new BridgeError.CoreUnavailable()
            : BridgeError.From(NativeMethods.rgbp_set_language(_handle, Language));
    }

    public BridgeError? SetAudioEnabled(bool enabled) =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable()
            : BridgeError.From(NativeMethods.rgbp_set_audio_enabled(_handle, enabled));

    public BridgeError? SetKeyReactiveEnabled(bool enabled) =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable()
            : BridgeError.From(NativeMethods.rgbp_set_key_reactive_enabled(_handle, enabled));

    public BridgeError? SetProtocolRegistered(bool registered) =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable()
            : BridgeError.From(NativeMethods.rgbp_set_protocol_registered(_handle, registered));

    public uint InputWanted() =>
        _handle == IntPtr.Zero ? 0u : NativeMethods.rgbp_input_wanted(_handle);

    public int PushKey(string name, bool down) =>
        _handle == IntPtr.Zero ? (int)FailureCode.InvalidArgument : NativeMethods.rgbp_push_key(_handle, name, down);

    public int PushAudio(ReadOnlySpan<float> interleaved, int frames, ushort channels, double sampleRate) =>
        _handle == IntPtr.Zero ? (int)FailureCode.InvalidArgument
            : NativeMethods.rgbp_push_audio_pcm(_handle, interleaved, (nuint)frames, channels, sampleRate);

    public string? DiagnosticsJson()
    {
        if (_handle == IntPtr.Zero) return null;
        Span<byte> buf = stackalloc byte[64 * 1024];
        var n = NativeMethods.rgbp_diagnostics_json(_handle, buf, (nuint)buf.Length);
        if (n <= 0) return null;
        return Encoding.UTF8.GetString(buf[..n].TrimEnd((byte)0));
    }

    /// <summary>
    /// Per-key keyboards from diagnostics, for the ⋯ menu's keyboard list
    /// (same source as the Mac <c>refreshKeyboards()</c>).
    /// </summary>
    public IReadOnlyList<string> RefreshKeyboards()
    {
        var json = DiagnosticsJson();
        if (json is null) return Array.Empty<string>();
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            if (!doc.RootElement.TryGetProperty("devices", out var devices)
                || devices.ValueKind != System.Text.Json.JsonValueKind.Array)
                return Array.Empty<string>();
            var names = new List<string>();
            foreach (var device in devices.EnumerateArray())
            {
                if (device.TryGetProperty("name", out var name) && name.GetString() is { Length: > 0 } text
                    && device.TryGetProperty("support", out var support) && support.GetString() == "per_key"
                    && !names.Contains(text))
                    names.Add(text);
            }
            return names;
        }
        catch (System.Text.Json.JsonException)
        {
            return Array.Empty<string>();
        }
    }

    public BridgeError? SetPreferredKeyboard(string? name) =>
        _handle == IntPtr.Zero ? new BridgeError.CoreUnavailable()
            : BridgeError.From(NativeMethods.rgbp_set_preferred_keyboard(_handle, name?.Trim() ?? ""));

    /// <summary>Live 104-key RGB frame from the same engine output the keyboard is playing.</summary>
    public PreviewFrame? PreviewFrame()
    {
        if (_handle == IntPtr.Zero) return null;
        Span<byte> bytes = stackalloc byte[104 * 3];
        var seq = NativeMethods.rgbp_preview_frame(_handle, bytes);
        if (seq < 0) return null;
        return new PreviewFrame(seq, bytes.ToArray());
    }

    public DriverInfo? LoadDriverInfo()
    {
        if (_handle == IntPtr.Zero) return null;
        Span<byte> buf = stackalloc byte[16 * 1024];
        var n = NativeMethods.rgbp_driver_info_json(_handle, buf, (nuint)buf.Length);
        if (n <= 0) return null;
        var json = Encoding.UTF8.GetString(buf[..n].TrimEnd((byte)0));
        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<DriverInfo>(
                json,
                new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (System.Text.Json.JsonException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_handle != IntPtr.Zero)
        {
            NativeMethods.rgbp_destroy(_handle);
            _handle = IntPtr.Zero;
        }
        FreePinned();
        GC.SuppressFinalize(this);
    }

    NativeMethods.RgbpConfig BuildConfig(BridgeConfig config)
    {
        return new NativeMethods.RgbpConfig
        {
            DataDir = Pin(config.DataDir),
            ApiBase = Pin(config.ApiBase),
            // The core accepts exactly "mac" or "win" (rgbp_create returns null otherwise).
            Platform = Pin("win"),
            Language = Pin(config.Language),
            AppVersion = Pin(config.AppVersion),
            OsVersion = Pin(config.OsVersion),
            OpenRgbAddr = config.OpenRgbAddr is null ? IntPtr.Zero : Pin(config.OpenRgbAddr),
        };
    }

    IntPtr Pin(string value)
    {
        // The core reads UTF-8 (paths can contain non-ASCII user names).
        var p = Marshal.StringToCoTaskMemUTF8(value);
        _pinned.Add(p);
        return p;
    }

    void FreePinned()
    {
        foreach (var p in _pinned) Marshal.FreeCoTaskMem(p);
        _pinned.Clear();
    }

    static string PtrToString(IntPtr p) => p == IntPtr.Zero ? "" : (Marshal.PtrToStringUTF8(p) ?? "");
    static string? PtrToStringOrNull(IntPtr p) => p == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(p);
}
