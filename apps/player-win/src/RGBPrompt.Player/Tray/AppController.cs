using System.Reflection;
using RGBPrompt.Player;
using RGBPrompt.Player.Core.Interop;
using RGBPrompt.Player.Core.Models;
using RGBPrompt.Player.Core.Services;
using RGBPrompt.Player.Input;
using RGBPrompt.Player.Services;
using RGBPrompt.Player.Views;

namespace RGBPrompt.Player.Tray;

/// <summary>
/// Owns the core bridge, tray icon and panel. Play/push never reveals the panel;
/// only <see cref="EntryPoint.RevealsPanel"/> (<c>rgbprompt://open</c>) or an
/// explicit tray click may show it.
/// </summary>
public sealed class AppController : IDisposable
{
    readonly PlayerCoreBridge _bridge;
    readonly PanelModel _panelModel = new();
    readonly TrayIconService _tray;
    readonly PanelWindow _panel;
    readonly InputCoordinator _input;
    readonly DeviceNotificationService _devices;
    SettingsWindow? _settings;
    // Mac `driverInstallDeferred`: after "稍后" a needsDriver state is stopped
    // again instead of nagging, until something actually plays.
    bool _driverInstallDeferred;

    public InputCoordinator Input => _input;

    /// <summary>Built-in effects (Presets\ next to the exe; same files as the Mac Player).</summary>
    public IReadOnlyList<PlayerPreset> Presets { get; } = PresetCatalog.Load();

    public AppController()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var dataDir = BridgeConfigBuilder.DataDirectory(localAppData);
        var cultureName = ShellPreferences.LoadLanguage(dataDir)
            ?? System.Globalization.CultureInfo.CurrentUICulture.Name;
        var config = BridgeConfigBuilder.Make(
            environment: Environment.GetEnvironmentVariables()
                .Cast<System.Collections.DictionaryEntry>()
                .ToDictionary(e => (string)e.Key, e => (string)(e.Value ?? "")),
            storedApiBase: null,
            storedOpenRgb: null,
            embeddedApiBase: null,
            appVersion: PlayerVersion(),
            osVersionString: Environment.OSVersion.VersionString,
            cultureName: cultureName,
            localAppData: localAppData);

        _bridge = new PlayerCoreBridge(config, SynchronizationContext.Current);
        _bridge.StateChanged += OnStateChanged;
        _panel = new PanelWindow(_bridge, _panelModel, this);
        _tray = new TrayIconService(
            onToggle: TogglePanel,
            onOpenSettings: OpenSettings,
            onQuit: Quit,
            language: config.Language);

        _input = new InputCoordinator(_bridge, new WasapiAudioCapture(), new LowLevelKeyCapture());
        _devices = new DeviceNotificationService(() => _ = _bridge.NotifyDevicesChanged());
    }

    static string PlayerVersion()
    {
        var informational = typeof(AppController).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational))
        {
            var plus = informational.IndexOf('+');
            return plus >= 0 ? informational[..plus] : informational;
        }
        return typeof(AppController).Assembly.GetName().Version?.ToString(3) ?? "0.6.0";
    }

    public void Start()
    {
#if DEBUG
        ApplyDevelopmentManifest();
#endif
        _tray.Show();
        // Intentionally do not show the panel on launch.
        ProtocolRegistrationService.EnsureRegistered(Environment.ProcessPath ?? "");
        _ = _bridge.SetProtocolRegistered(ProtocolRegistrationService.IsRegistered());
        _devices.Start();
        _input.Start();
        if (ShellPreferences.LoadKeyboard(_bridge.Config.DataDir) is { } keyboard)
            _ = _bridge.SetPreferredKeyboard(keyboard);
        _ = _bridge.SetBrightness(Brightness);
#if DEBUG
        ApplyDebugPanelScene();
#endif
    }

#if DEBUG
    /// <summary>
    /// Debug builds only, same as the Mac Player: <c>RGBP_DEV_DRIVER_MANIFEST</c>
    /// is a JSON manifest path (for example a loopback-served patched OpenRGB
    /// zip for K552 testing). Release builds have no such code path.
    /// </summary>
    void ApplyDevelopmentManifest()
    {
        var path = Environment.GetEnvironmentVariable("RGBP_DEV_DRIVER_MANIFEST");
        if (string.IsNullOrEmpty(path) || !System.IO.File.Exists(path)) return;
        try
        {
            var error = _bridge.SetDriverManifest(System.IO.File.ReadAllText(path));
            System.Diagnostics.Debug.WriteLine(error is null
                ? "driver_manifest_override"
                : $"driver_manifest_override failed: {error}");
        }
        catch (System.IO.IOException ex)
        {
            System.Diagnostics.Debug.WriteLine($"driver_manifest_override failed: {ex.GetType().Name}");
        }
    }

    /// <summary>
    /// Debug builds only, same as the Mac Player:
    /// <c>RGBP_DEBUG_PANEL=preset:&lt;id&gt;[,picker][,settings]</c> plays a
    /// built-in effect and shows the panel after 2 s (with the effect picker
    /// open, or the settings window after 8 s), so states can be reviewed
    /// without clicking.
    /// </summary>
    readonly List<Microsoft.UI.Dispatching.DispatcherQueueTimer> _debugTimers = new();

    static Microsoft.UI.Dispatching.DispatcherQueueTimer After(TimeSpan delay, Action action)
    {
        var timer = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread().CreateTimer();
        timer.Interval = delay;
        timer.IsRepeating = false;
        timer.Tick += (_, _) => action();
        timer.Start();
        return timer;
    }

    void ApplyDebugPanelScene()
    {
        var scene = Environment.GetEnvironmentVariable("RGBP_DEBUG_PANEL");
        if (string.IsNullOrEmpty(scene)) return;
        foreach (var part in scene.Split(','))
        {
            if (!part.StartsWith("preset:", StringComparison.Ordinal)) continue;
            var id = part["preset:".Length..];
            var preset = Presets.FirstOrDefault(p => p.Id == id);
            if (preset != null) PlayPreset(preset);
        }
        var picker = scene.Split(',').Contains("picker");
        // Keep the timers referenced: an unreferenced DispatcherQueueTimer can be
        // collected before it fires (seen with the 8 s settings timer).
        _debugTimers.Add(After(TimeSpan.FromSeconds(2), () =>
        {
            ShowPanel();
            if (picker) _panel.OpenPicker();
        }));
        if (scene.Contains("settings", StringComparison.OrdinalIgnoreCase))
            _debugTimers.Add(After(TimeSpan.FromSeconds(8), OpenSettings));
    }
#endif

    /// <summary>Plays a built-in effect. Never changes panel visibility.</summary>
    public void PlayPreset(PlayerPreset preset)
    {
        if (preset.FilePath is null) return;
        _driverInstallDeferred = false;
        _ = _bridge.OpenLepFile(preset.FilePath, preset.Id);
        _panel.Refresh();
    }

    public void Open(EntryPoint entry)
    {
        // Play/push must not change panel visibility. Only rgbprompt://open
        // may show the panel; otherwise a hidden panel stays hidden.
        if (entry.RevealsPanel)
        {
            ShowPanel();
            return;
        }

        switch (entry)
        {
            case EntryPoint.PlayerUrl url:
                _ = _bridge.OpenUrl(url.Url.AbsoluteUri);
                break;
            case EntryPoint.LepFile file:
                // A copy of a built-in effect opened from Explorer plays as that preset.
                _ = _bridge.OpenLepFile(file.Path, PresetCatalog.MatchBundled(file.Path, Presets));
                break;
            case EntryPoint.Ignored:
                break;
        }
    }

    public void ShowPanel() => _panel.Reveal();
    public void HidePanel() => _panel.Conceal();
    public void TogglePanel()
    {
        if (_panel.IsRevealed) HidePanel();
        else ShowPanel();
    }

    public void StopPlayback() => _ = _bridge.Stop();
    public void Retry() => _ = _bridge.Retry();
    public void InstallDriver()
    {
        _driverInstallDeferred = false;
        _ = _bridge.InstallDriver();
    }

    /// <summary>Retry from the driver card (Mac <c>retryDriver</c>): also ends a "稍后" deferral.</summary>
    public void RetryDriver()
    {
        _driverInstallDeferred = false;
        _ = _bridge.Retry();
    }

    /// <summary>"稍后" (Mac <c>declineDriver</c>): stop, and keep stopping needsDriver until something plays.</summary>
    public void DeclineDriver()
    {
        _driverInstallDeferred = true;
        _ = _bridge.Stop();
    }

    public IReadOnlyList<string> Keyboards() => _bridge.RefreshKeyboards();

    public void SelectKeyboard(string name)
    {
        ShellPreferences.SaveKeyboard(_bridge.Config.DataDir, name);
        _ = _bridge.SetPreferredKeyboard(name);
    }

    /// <summary>Mac <c>BrightnessPreference</c>: 10–100 in steps of 5, default 100, persisted.</summary>
    public int Brightness => SnapBrightness(ShellPreferences.LoadBrightness(_bridge.Config.DataDir) ?? 100);

    public void SetBrightness(int value)
    {
        var snapped = SnapBrightness(value);
        ShellPreferences.SaveBrightness(_bridge.Config.DataDir, snapped);
        _ = _bridge.SetBrightness(snapped);
    }

    public static int SnapBrightness(int value)
    {
        var clamped = Math.Clamp(value, 10, 100);
        return Math.Clamp(10 + (int)Math.Round((clamped - 10) / 5.0, MidpointRounding.AwayFromZero) * 5, 10, 100);
    }
    public void RestartBackend() => _ = _bridge.RestartBackend();

    public void SetAudioEnabled(bool enabled)
    {
        _input.SetAudioEnabled(enabled);
        _ = _bridge.SetAudioEnabled(enabled);
        _panel.Refresh();
    }

    public void SetKeyReactiveEnabled(bool enabled)
    {
        _input.SetKeyReactiveEnabled(enabled);
        _ = _bridge.SetKeyReactiveEnabled(enabled);
        _panel.Refresh();
    }

    public void OpenSettings()
    {
        HidePanel();
        if (_settings is null)
        {
            _settings = new SettingsWindow(_bridge, this);
            _settings.Closed += (_, _) => _settings = null;
        }
        _settings.Activate();
    }

    public void Quit()
    {
        _ = _bridge.Stop();
        if (Microsoft.UI.Xaml.Application.Current is App app)
        {
            app.Shutdown();
            return;
        }
        Dispose();
        Microsoft.UI.Xaml.Application.Current?.Exit();
        Environment.Exit(0);
    }

    /// <summary>Windows counterpart of the Mac "打开活动监视器" button on the vendor card.</summary>
    public void OpenTaskManager()
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("taskmgr.exe") { UseShellExecute = true });
        }
        catch
        {
            // Not fatal; the steps on the card still explain what to do.
        }
    }

    public string? CopyDiagnostics()
    {
        var json = _bridge.DiagnosticsJson();
        if (json is null) return null;
        return json;
    }

    public bool CopyDiagnosticsToClipboard()
    {
        var json = CopyDiagnostics();
        if (json is null) return false;
        var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
        package.SetText(json);
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
        return true;
    }

    public void OpenLepPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        _driverInstallDeferred = false;
        Open(new EntryPoint.LepFile(path));
    }

    public void MakeDefaultHandler()
    {
        ProtocolRegistrationService.EnsureRegistered(Environment.ProcessPath ?? "");
        _ = _bridge.SetProtocolRegistered(true);
        _settings?.RefreshStatus();
    }

    public void OpenDownloadPage() => OpenSite("player");
    public void OpenSupportedKeyboards() => OpenSite("player");
    public void OpenStudio() => OpenSite("app");
    /// <summary>"创作你自己的灯效" and the failure card's create button (Mac <c>openLibrary</c>).</summary>
    public void OpenLibrary()
    {
        HidePanel();
        OpenSite("library");
    }

    void OpenSite(string path)
    {
        var url = BridgeConfigBuilder.SiteOrigin(_bridge.Config.ApiBase) is { } origin
            ? new Uri(origin, path).AbsoluteUri
            : "https://rgbprompt.com/" + path;
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            _ = _bridge.OpenUrl(url);
        }
    }

    public void SetLanguage(string language)
    {
        ShellPreferences.SaveLanguage(_bridge.Config.DataDir, language);
        _ = _bridge.SetLanguage(language);
        _tray.SetLanguage(_bridge.Language);
        _panel.Relocalize();
        _settings?.Relocalize();
    }

    void OnStateChanged(CoreStateEvent ev)
    {
        var state = PanelState.FromEvent(ev);
        if (state is PanelState.NeedsDriver && _driverInstallDeferred)
        {
            // Same as the Mac: a Studio retry after "稍后" must not bring the prompt back.
            _ = _bridge.Stop();
            return;
        }
        if (state is PanelState.Playing) _driverInstallDeferred = false;
        _panelModel.Apply(state, ev.KeyboardName);
        _tray.UpdateBadge(StatusBadgeMapping.From(state));
        _panel.Refresh();
        _settings?.RefreshStatus();
        _input.Update(state);
        // Never auto-reveal the panel on Playing / Preparing / NeedsDriver.
        // Setup/driver prompts appear inside the panel when the user opens it.
    }

    public void Dispose()
    {
        _input.Dispose();
        _devices.Dispose();
        // Stop the core/managed helper before disposing the tray: Quit is
        // invoked from the tray menu, and tray disposal must not be able to
        // skip the helper cleanup if it throws.
        _bridge.Dispose();
        _tray.Dispose();
    }
}
