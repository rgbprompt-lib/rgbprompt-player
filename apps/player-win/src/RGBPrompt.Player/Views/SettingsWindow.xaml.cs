using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using RGBPrompt.Player.Core.Interop;
using RGBPrompt.Player.Core.Models;
using RGBPrompt.Player.Services;
using RGBPrompt.Player.Tray;

namespace RGBPrompt.Player.Views;

/// <summary>
/// Settings, a 1:1 port of the Mac <c>SettingsRootView</c>: Status card
/// (driver, keyboard, web link), Preferences card (language, sound source,
/// brightness, launch at login, stop behaviour) and the footer. 400×560
/// content under a 32 DIP custom title bar; no system caption.
/// </summary>
public sealed partial class SettingsWindow : Window
{
    const uint WmNclButtonDown = 0x00A1;
    const nint HtCaption = 2;

    readonly PlayerCoreBridge _bridge;
    readonly AppController _controller;
    readonly Button _closeButton;
    Slider? _brightness;
    TextBlock? _brightnessValue;
    bool _copied;
    bool _suppressSlider;

    // Field, not local: an unreferenced DispatcherQueueTimer can be collected before it fires.
    Microsoft.UI.Dispatching.DispatcherQueueTimer? _copiedTimer;

    string Language => _bridge.Language;
    IntPtr Hwnd => WinRT.Interop.WindowNative.GetWindowHandle(this);

    public SettingsWindow(PlayerCoreBridge bridge, AppController controller)
    {
        _bridge = bridge;
        _controller = controller;
        InitializeComponent();
        PlayerTheme.Ensure();
        ExtendsContentIntoTitleBar = true;
        if (AppWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter presenter)
        {
            presenter.IsResizable = false;
            presenter.IsMaximizable = false;
            presenter.IsMinimizable = false;
            presenter.SetBorderAndTitleBar(hasBorder: true, hasTitleBar: false);
        }
        Root.Background = PlayerTheme.WindowBackgroundBrush;
        TitleText.FontFamily = PlayerTheme.FontSemibold;
        TitleText.FontWeight = PlayerTheme.SemiBold;
        TitleText.FontSize = 13;
        TitleText.Foreground = PlayerTheme.TextBrush;
        _closeButton = PanelUi.HeaderIcon("\uE711", 10, Close);
        TitleButtons.Children.Add(_closeButton);
        WindowSizing.ResizeClientDip(AppWindow, Hwnd, PlayerTheme.SettingsWidth,
            PlayerTheme.SettingsTitleBarHeight + PlayerTheme.SettingsContentHeight);
        Rebuild();
    }

    public void Relocalize() => Rebuild();

    public void RefreshStatus() => BuildStatus();

    void Rebuild()
    {
        Title = L10n.Tr("settings.title", Language);
        TitleText.Text = Title;
        ToolTipService.SetToolTip(_closeButton, L10n.Tr("panel.hide", Language));
        BuildStatus();
        BuildPreferences();
        BuildFooter();
    }

    // MARK: - Status

    void BuildStatus()
    {
        StatusSection.Children.Clear();
        StatusSection.Children.Add(SectionLabel("settings.section.status"));
        var card = CardStack();

        var info = _bridge.LoadDriverInfo();
        var driverOk = _bridge.State is PanelState.Playing or PanelState.Idle or PanelState.Preparing or PanelState.NoKeyboard;
        card.Children.Add(StatusRow(driverOk, "settings.status.driver", DriverDetailText(info, driverOk), null));
        card.Children.Add(PanelUi.Divider(new Thickness(0)));

        var keyboardOk = !string.IsNullOrEmpty(_bridge.KeyboardName);
        card.Children.Add(StatusRow(keyboardOk, "settings.status.keyboard",
            keyboardOk ? _bridge.KeyboardName : L10n.Tr("settings.status.keyboardMissing", Language), null));
        card.Children.Add(PanelUi.Divider(new Thickness(0)));

        var webOk = ProtocolRegistrationService.IsRegistered();
        card.Children.Add(StatusRow(webOk, "settings.status.webLink",
            L10n.Tr(webOk ? "settings.status.webRegistered" : "settings.status.webMissing", Language),
            webOk ? null : PanelUi.Link(L10n.Tr("settings.webLink.makeDefault", Language), 12, _controller.MakeDefaultHandler)));
        StatusSection.Children.Add(Card(card));
    }

    string DriverDetailText(DriverInfo? info, bool ready)
    {
        if (info?.Mode == "external" && info.Port is { } port)
            return L10n.Tr("settings.status.driverExternal", Language, port);
        if (ready && !string.IsNullOrEmpty(info?.Version))
            return L10n.Tr("settings.status.driverReady", Language, info.Version);
        if (ready)
            return L10n.Tr(_bridge.State.StatusLocalizationKey, Language);
        return L10n.Tr("settings.status.driverMissing", Language);
    }

    FrameworkElement StatusRow(bool ok, string titleKey, string detail, Button? action)
    {
        var grid = new Grid { ColumnSpacing = 10, Padding = new Thickness(12, 10, 12, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var circle = new Grid { Width = 16, Height = 16, VerticalAlignment = VerticalAlignment.Center };
        circle.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Fill = ok ? PlayerTheme.PrimaryBrush : PlayerTheme.ControlBrush });
        if (ok)
        {
            var check = PanelUi.Glyph("\uE73E", 9, PlayerTheme.OnPrimaryBrush, bold: true);
            check.HorizontalAlignment = HorizontalAlignment.Center;
            check.VerticalAlignment = VerticalAlignment.Center;
            circle.Children.Add(check);
        }
        grid.Children.Add(circle);

        var title = PanelUi.Text(L10n.Tr(titleKey, Language), 13, PlayerTheme.TextBrush, wrap: false);
        title.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(title, 1);
        grid.Children.Add(title);

        var detailText = PanelUi.Text(detail, 12, PlayerTheme.TertiaryBrush, wrap: false);
        detailText.VerticalAlignment = VerticalAlignment.Center;
        detailText.HorizontalAlignment = HorizontalAlignment.Right;
        detailText.Margin = new Thickness(8, 0, 0, 0);
        Grid.SetColumn(detailText, 2);
        grid.Children.Add(detailText);

        if (action != null)
        {
            action.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(action, 3);
            grid.Children.Add(action);
        }
        return grid;
    }

    // MARK: - Preferences

    void BuildPreferences()
    {
        PreferencesSection.Children.Clear();
        PreferencesSection.Children.Add(SectionLabel("settings.section.preferences"));
        var card = CardStack();

        var zh = Language.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        card.Children.Add(PreferenceRow("settings.preference.language", PanelUi.Segmented(
            new[] { ("zh-CN", L10n.Tr("settings.language.chinese", Language)), ("en", L10n.Tr("settings.language.english", Language)) },
            zh ? "zh-CN" : "en",
            value => _controller.SetLanguage(value))));
        card.Children.Add(PanelUi.Divider(new Thickness(0)));

        var audio = _controller.Input.AudioEnabled;
        card.Children.Add(PreferenceRow("settings.preference.sound", PanelUi.Segmented(
            new[] { (true, L10n.Tr("settings.sound.system", Language)), (false, L10n.Tr("settings.sound.off", Language)) },
            audio,
            value =>
            {
                _controller.SetAudioEnabled(value);
                BuildPreferences();
            })));
        card.Children.Add(PanelUi.Divider(new Thickness(0)));

        card.Children.Add(BrightnessRow());
        card.Children.Add(PanelUi.Divider(new Thickness(0)));
        card.Children.Add(LaunchRow());
        card.Children.Add(PanelUi.Divider(new Thickness(0)));

        var stop = new StackPanel { Spacing = 2, Padding = new Thickness(12, 10, 12, 10) };
        stop.Children.Add(PanelUi.Text(L10n.Tr("settings.stop.title", Language), 13, PlayerTheme.TextBrush));
        stop.Children.Add(PanelUi.Text(L10n.Tr("settings.stop.body", Language), 11, PlayerTheme.TertiaryBrush));
        card.Children.Add(stop);
        PreferencesSection.Children.Add(Card(card));
    }

    FrameworkElement PreferenceRow(string titleKey, FrameworkElement control)
    {
        var grid = new Grid { ColumnSpacing = 12, Padding = new Thickness(12, 10, 12, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var title = PanelUi.Text(L10n.Tr(titleKey, Language), 13, PlayerTheme.TextBrush, wrap: false);
        title.VerticalAlignment = VerticalAlignment.Center;
        grid.Children.Add(title);
        Grid.SetColumn(control, 1);
        grid.Children.Add(control);
        return grid;
    }

    FrameworkElement BrightnessRow()
    {
        var grid = new Grid { ColumnSpacing = 12, Padding = new Thickness(12, 10, 12, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(140) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(38) });
        var title = PanelUi.Text(L10n.Tr("settings.preference.brightness", Language), 13, PlayerTheme.TextBrush, wrap: false);
        title.VerticalAlignment = VerticalAlignment.Center;
        grid.Children.Add(title);

        var value = _controller.Brightness;
        _brightness = new Slider
        {
            Minimum = 10,
            Maximum = 100,
            // Snap in code like the Mac binding (no tick marks).
            StepFrequency = 1,
            TickPlacement = Microsoft.UI.Xaml.Controls.Primitives.TickPlacement.None,
            IsThumbToolTipEnabled = false,
            Width = 140,
            // WinUI reserves ~32 DIP for the slider; the Mac row is text height.
            Height = 24,
            Margin = new Thickness(0, -4, 0, -4),
            VerticalAlignment = VerticalAlignment.Center,
        };
        TintSlider(_brightness);
        _suppressSlider = true;
        _brightness.Value = value;
        _suppressSlider = false;
        _brightness.ValueChanged += (_, e) =>
        {
            if (_suppressSlider) return;
            var snapped = AppController.SnapBrightness((int)Math.Round(e.NewValue));
            _controller.SetBrightness(snapped);
            if (_brightnessValue != null) _brightnessValue.Text = L10n.Tr("settings.brightness.value", Language, snapped);
        };
        Grid.SetColumn(_brightness, 1);
        grid.Children.Add(_brightness);

        _brightnessValue = PanelUi.Text(L10n.Tr("settings.brightness.value", Language, value), 12,
            PlayerTheme.TertiaryBrush, wrap: false, family: PlayerTheme.FontMono);
        _brightnessValue.HorizontalAlignment = HorizontalAlignment.Right;
        _brightnessValue.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(_brightnessValue, 2);
        grid.Children.Add(_brightnessValue);
        return grid;
    }

    /// <summary>Mac <c>.tint(Theme.primary)</c> on the slider track.</summary>
    static void TintSlider(Slider slider)
    {
        foreach (var key in new[] { "SliderTrackValueFill", "SliderTrackValueFillPointerOver", "SliderTrackValueFillPressed" })
            slider.Resources[key] = PlayerTheme.PrimaryBrush;
        foreach (var key in new[] { "SliderTrackFill", "SliderTrackFillPointerOver", "SliderTrackFillPressed" })
            slider.Resources[key] = PlayerTheme.ControlBrush;
        foreach (var key in new[] { "SliderThumbBackground", "SliderThumbBackgroundPointerOver", "SliderThumbBackgroundPressed" })
            slider.Resources[key] = PlayerTheme.TextBrush;
        slider.Resources["SliderOuterThumbBackground"] = PlayerTheme.TextBrush;
    }

    FrameworkElement LaunchRow()
    {
        var grid = new Grid { ColumnSpacing = 12, Padding = new Thickness(12, 10, 12, 10) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var text = new StackPanel { Spacing = 2 };
        text.Children.Add(PanelUi.Text(L10n.Tr("settings.preference.launchAtLogin", Language), 13, PlayerTheme.TextBrush));
        text.Children.Add(PanelUi.Text(L10n.Tr("settings.launch.hint", Language), 11, PlayerTheme.TertiaryBrush));
        grid.Children.Add(text);
        var on = StartupRegistrationService.IsEnabled();
        var toggle = PanelUi.Toggle(on, true, () =>
        {
            StartupRegistrationService.SetEnabled(!on, Environment.ProcessPath ?? "");
            BuildPreferences();
        });
        toggle.VerticalAlignment = VerticalAlignment.Center;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(toggle, L10n.Tr("settings.preference.launchAtLogin", Language));
        Grid.SetColumn(toggle, 1);
        grid.Children.Add(toggle);
        return grid;
    }

    // MARK: - Footer

    void BuildFooter()
    {
        Footer.Children.Clear();
        Footer.ColumnDefinitions.Clear();
        Footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var version = PanelUi.Text(L10n.Tr("settings.footer.version", Language, _bridge.Config.AppVersion), 12,
            PlayerTheme.TertiaryBrush, wrap: false);
        version.VerticalAlignment = VerticalAlignment.Center;
        Footer.Children.Add(version);
        var links = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        links.Children.Add(PanelUi.Link(L10n.Tr("settings.footer.checkUpdates", Language), 12, _controller.OpenDownloadPage));
        links.Children.Add(PanelUi.Link(L10n.Tr(_copied ? "settings.footer.copied" : "settings.footer.copyDiagnostics", Language), 12, CopyDiagnostics));
        Grid.SetColumn(links, 1);
        Footer.Children.Add(links);
    }

    void CopyDiagnostics()
    {
        if (!_controller.CopyDiagnosticsToClipboard()) return;
        _copied = true;
        BuildFooter();
        _copiedTimer?.Stop();
        var timer = _copiedTimer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(2);
        timer.IsRepeating = false;
        timer.Tick += (_, _) =>
        {
            _copied = false;
            BuildFooter();
        };
        timer.Start();
    }

    // MARK: - Pieces

    TextBlock SectionLabel(string key) => PanelUi.Text(L10n.Tr(key, Language), 12, PlayerTheme.SecondaryBrush, wrap: false);

    static StackPanel CardStack() => new();

    /// <summary>Mac settings card: background fill, 1 px border, radius 12.</summary>
    static Border Card(UIElement content) => new()
    {
        Child = content,
        Background = PlayerTheme.BackgroundBrush,
        BorderBrush = PlayerTheme.BorderBrush,
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(12),
    };

    void TitleBar_PointerPressed(object sender, PointerRoutedEventArgs e)
    {
        if (e.OriginalSource is DependencyObject source && IsInside(source, _closeButton)) return;
        if (!e.GetCurrentPoint(TitleBar).Properties.IsLeftButtonPressed) return;
        ReleaseCapture();
        SendMessage(Hwnd, WmNclButtonDown, HtCaption, 0);
    }

    static bool IsInside(DependencyObject source, DependencyObject target)
    {
        DependencyObject? cur = source;
        while (cur != null)
        {
            if (ReferenceEquals(cur, target)) return true;
            cur = VisualTreeHelper.GetParent(cur);
        }
        return false;
    }

    [DllImport("user32.dll")]
    static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    static extern nint SendMessage(IntPtr hWnd, uint msg, nint wParam, nint lParam);
}
