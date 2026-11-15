using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using RGBPrompt.Player.Core.Interop;
using RGBPrompt.Player.Core.Models;
using RGBPrompt.Player.Input;
using RGBPrompt.Player.Services;
using RGBPrompt.Player.Tray;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Windows.Storage.Pickers;
using Windows.System;
using WinRT.Interop;

namespace RGBPrompt.Player.Views;

/// <summary>
/// The tray panel, a 1:1 port of the Mac <c>PanelRootView</c>: header (mark,
/// name, status, ⋯, ×), the now-playing view (live keyboard, input chip,
/// selector row) or one state card, and the effect picker that replaces the
/// content when opened. The window is 340 wide and as tall as its content.
/// </summary>
public sealed partial class PanelWindow : Window
{
    readonly PlayerCoreBridge _bridge;
    readonly PanelModel _panelModel;
    readonly AppController _controller;
    readonly PreviewPoller _poller;
    readonly Microsoft.UI.Windowing.AppWindow _appWindow;
    bool _revealed;
    bool _dropTargeted;
    bool _pickerOpen;
    int? _highlighted;
    bool _diagnosticsCopied;
    double _lastHeight;
    // The current card is rebuilt only when its shape changes; download
    // progress updates these two controls in place so the buttons, bullets and
    // the bar itself do not flicker on every percent.
    string? _cardKey;
    ProgressBar? _driverProgress;
    TextBlock? _driverPercent;
    string? _selectorKey;
    Border? _selectorSwatch;
    readonly Button _moreButton;
    readonly Button _closeButton;

    public bool IsRevealed => _revealed;
    public IntPtr Hwnd => WindowNative.GetWindowHandle(this);

    public PanelWindow(PlayerCoreBridge bridge, PanelModel panelModel, AppController controller)
    {
        _bridge = bridge;
        _panelModel = panelModel;
        _controller = controller;
        InitializeComponent();
        PlayerTheme.Ensure();
        ExtendsContentIntoTitleBar = true;
        var hwnd = Hwnd;
        var id = Microsoft.UI.Win32Interop.GetWindowIdFromWindow(hwnd);
        _appWindow = Microsoft.UI.Windowing.AppWindow.GetFromWindowId(id);
        _appWindow.IsShownInSwitchers = false;
        ApplyCustomChrome(_appWindow);
        // Native WinUI caption region: the 48 DIP header minus ⋯ / ×.
        // Pointer release, leave, cancel and focus loss end the move;
        // do not use WM_NCLBUTTONDOWN / ReleaseCapture on the XAML island.
        SetTitleBar(HeaderDragRegion);

        _moreButton = PanelUi.HeaderIcon("\uE712", 12, ShowMoreMenu);
        _closeButton = PanelUi.HeaderIcon("\uE711", 10, _controller.HidePanel);
        HeaderButtons.Children.Add(_moreButton);
        HeaderButtons.Children.Add(_closeButton);
        ApplyShellTheme();
        AddShortcuts();

        WindowSizing.ResizeClientDip(_appWindow, hwnd, PlayerTheme.PanelWidth, 400);
        _appWindow.Hide();
        _revealed = false;

        _poller = new PreviewPoller(_bridge);
        _poller.FrameChanged += OnPreviewFrame;
        HeroCard.SizeChanged += (_, e) =>
        {
            if (e.NewSize.Width > 1)
                HeroKeyboard.Height = (e.NewSize.Width - 22) / KeyLayout.Aspect;
        };
        RootStack.SizeChanged += (_, _) => FitToContent();
        RootGrid.PreviewKeyDown += Root_KeyDown;

        ApplyStaticCopy();
        Refresh();
    }

    // Field, not local: an unreferenced DispatcherQueueTimer can be collected before it fires.
    Microsoft.UI.Dispatching.DispatcherQueueTimer? _copiedTimer;

    string Language => _bridge.Language;

    void ApplyStaticCopy()
    {
        Title = L10n.Tr("app.name", Language);
        AppNameText.Text = "RGBPrompt";
        ToolTipService.SetToolTip(_moreButton, L10n.Tr("panel.more", Language));
        ToolTipService.SetToolTip(_closeButton, L10n.Tr("panel.hide", Language));
        HeroIdleText.Text = L10n.Tr("panel.idle.dropHere", Language);
        HeroPreparingText.Text = L10n.Tr("panel.preparing", Language);
        HeroDropHint.Text = L10n.Tr("panel.drop.release", Language);
        ChipEnableText.Text = L10n.Tr("panel.chip.enable", Language);
        StoppedHint.Text = L10n.Tr("panel.stoppedHint", Language);
    }

    // MARK: - Window

    public void Reveal()
    {
        _appWindow.Show();
        Activate();
        _revealed = true;
        Refresh();
        RootStack.UpdateLayout();
        FitToContent(force: true);
    }

    public void Conceal()
    {
        _appWindow.Hide();
        _revealed = false;
        _pickerOpen = false;
        _poller.SetActive(false);
    }

    public void Relocalize()
    {
        ApplyStaticCopy();
        _cardKey = null;
        _selectorKey = null;
        Refresh();
    }

    /// <summary>Mac panel: the window is exactly as tall as its SwiftUI content.</summary>
    void FitToContent(bool force = false)
    {
        // RootStack sits in a ScrollViewer, so it is measured unbounded and
        // ActualHeight is the full content height.
        // Header sits above the ScrollViewer, so add its 48 DIP row to the
        // unbounded content stack height.
        var header = HeaderBar.ActualHeight > 1 ? HeaderBar.ActualHeight : 48;
        var height = Math.Min(PlayerTheme.PanelMaxHeight, Math.Ceiling(header + RootStack.ActualHeight));
        if (height < 48) return;
        if (!force && Math.Abs(height - _lastHeight) < 0.5) return;
        _lastHeight = height;
        WindowSizing.ResizeClientDip(_appWindow, Hwnd, PlayerTheme.PanelWidth, height);
    }

    // MARK: - Refresh

    bool ShowsSelector => _bridge.State is PanelState.Idle or PanelState.Playing or PanelState.Preparing;

    public void Refresh()
    {
        var state = _bridge.State;
        var issue = BackendIssue.From(state, state is PanelState.BackendUnresponsive ? _bridge.LoadDriverInfo() : null);
        StatusText.Text = HeaderStatus(state, issue);
        ToolTipService.SetToolTip(StatusText, StatusText.Text);
        StatusDot.Fill = StatusColor(state);

        // Mac: `ui.pickerOpen && showsSelector`; the flag survives a passing
        // state (e.g. preparing → noKeyboard → playing) instead of resetting.
        var showsPicker = _pickerOpen && ShowsSelector;
        MainHost.Visibility = showsPicker ? Visibility.Collapsed : Visibility.Visible;
        PickerHost.Visibility = showsPicker ? Visibility.Visible : Visibility.Collapsed;
        if (showsPicker)
        {
            BuildPicker();
        }
        else
        {
            RefreshContent(state, issue);
        }

        ConflictHint.Visibility = _panelModel.HasConflictHint ? Visibility.Visible : Visibility.Collapsed;
        if (_panelModel.HasConflictHint)
            ConflictHint.Text = L10n.Tr("panel.footer.reopenVendors", Language, _panelModel.Conflicts.DisplayNames);

        DropOutline.Visibility = _dropTargeted ? Visibility.Visible : Visibility.Collapsed;
        _poller.SetActive(_revealed && state is PanelState.Playing);
        if (state is not PanelState.Playing)
            HeroKeyboard.SetFrame(null, outline: true);
        FitToContent();
    }

    void RefreshContent(PanelState state, BackendIssue? issue)
    {
        var isPlaying = state is PanelState.Playing;
        var isPreparing = state is PanelState.Preparing;
        var idleFailure = state is PanelState.Idle { Failure: { } f } && f != FailureCode.DriverDeclined
            ? (FailureCode?)f
            : null;
        var selector = ShowsSelector;

        HeroCard.Visibility = selector && idleFailure is null ? Visibility.Visible : Visibility.Collapsed;
        SelectorRow.Visibility = selector ? Visibility.Visible : Visibility.Collapsed;
        MainHost.Padding = new Thickness(16, 0, 16, 16);

        var cardKey = CardKey(state, issue, idleFailure);
        if (cardKey is not null && cardKey == _cardKey && state is PanelState.NeedsDriver { Progress: { } inPlace })
        {
            if (_driverProgress is not null) _driverProgress.Value = inPlace;
            if (_driverPercent is not null) _driverPercent.Text = L10n.Tr("panel.needsDriver.percent", Language, inPlace);
        }
        else if (cardKey != _cardKey)
        {
            _cardKey = cardKey;
            _driverProgress = null;
            _driverPercent = null;
            CardHost.Children.Clear();
            if (BuildCard(state, issue, idleFailure) is { } card)
                CardHost.Children.Add(card);
        }
        CardHost.Visibility = CardHost.Children.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

        if (HeroCard.Visibility == Visibility.Visible)
            UpdateHero(isPlaying, isPreparing);
        if (selector)
            RefreshSelector(isPlaying, isPreparing);

        StoppedHint.Visibility = selector && _bridge.StoppedByUser && !isPlaying && !isPreparing
            ? Visibility.Visible : Visibility.Collapsed;
        UpdateChip();
    }

    string? CardKey(PanelState state, BackendIssue? issue, FailureCode? idleFailure)
    {
        var lang = Language;
        if (idleFailure is { } failure) return $"failure|{failure}|{_diagnosticsCopied}|{lang}";
        return state switch
        {
            PanelState.NeedsDriver n => $"needsDriver|{n.Progress is null}|{n.DriverError}|{lang}",
            PanelState.NoKeyboard n => $"noKeyboard|{n.DeviceLost}|{lang}",
            PanelState.BackendUnresponsive => $"backend|{issue}|{_diagnosticsCopied}|{lang}",
            PanelState.VendorConflict v => $"vendor|{v.Name}|{_diagnosticsCopied}|{lang}",
            PanelState.Blocked => $"blocked|{lang}",
            PanelState.CoreUnavailable => $"core|{lang}",
            _ => null,
        };
    }

    string HeaderStatus(PanelState state, BackendIssue? issue)
    {
        if (issue is not null) return L10n.Tr(issue.HeaderStatusKey, Language);
        if (state is PanelState.Playing or PanelState.Idle or PanelState.Preparing)
        {
            var name = ShortKeyboardName(_bridge.KeyboardName);
            return name.Length == 0 ? L10n.Tr("panel.status.ready", Language) : name;
        }
        return L10n.Tr(state.StatusLocalizationKey, Language);
    }

    /// <summary>OpenRGB names often end in a USB id ("EVision Keyboard 320F:5000 …").</summary>
    internal static string ShortKeyboardName(string? raw)
    {
        var trimmed = (raw ?? "").Trim();
        var match = System.Text.RegularExpressions.Regex.Match(trimmed, @"\s+[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}.*$");
        return match.Success ? trimmed[..match.Index] : trimmed;
    }

    static Brush StatusColor(PanelState state) => state switch
    {
        PanelState.Playing => PlayerTheme.PrimaryBrush,
        PanelState.Idle { Failure: null } => PlayerTheme.TertiaryBrush,
        PanelState.Idle => PlayerTheme.WarningBrush,
        PanelState.Preparing => PlayerTheme.TertiaryBrush,
        PanelState.CoreUnavailable => PlayerTheme.DangerBrush,
        _ => PlayerTheme.WarningBrush,
    };

    // MARK: - Hero

    void UpdateHero(bool isPlaying, bool isPreparing)
    {
        var overlay = !isPlaying && !_dropTargeted;
        HeroScrim.Background = _dropTargeted ? PlayerTheme.DropScrimBrush
            : overlay ? PlayerTheme.ScrimBrush : PlayerTheme.TransparentBrush;
        HeroDropHint.Visibility = _dropTargeted ? Visibility.Visible : Visibility.Collapsed;
        HeroPreparing.Visibility = overlay && isPreparing ? Visibility.Visible : Visibility.Collapsed;
        HeroIdleHint.Visibility = overlay && !isPreparing ? Visibility.Visible : Visibility.Collapsed;
        if (isPlaying && _poller.Frame is { } frame)
            HeroKeyboard.SetFrame(frame.Rgb, outline: false);
        else if (!isPlaying)
            HeroKeyboard.SetFrame(null, outline: true);
    }

    void OnPreviewFrame(PreviewFrame? frame)
    {
        if (_bridge.State is PanelState.Playing && frame is { } f)
        {
            HeroKeyboard.SetFrame(f.Rgb, outline: false);
            if (_selectorSwatch is not null) KeySwatch.Paint(_selectorSwatch, f.Rgb);
        }
        UpdateChip();
    }

    // MARK: - Input chip

    void UpdateChip()
    {
        var input = _controller.Input;
        if (_bridge.State is not PanelState.Playing || input is null || (_pickerOpen && ShowsSelector))
        {
            SetChipVisible(false);
            return;
        }
        if (input.EffectWantsKeys && !input.KeyEnabled)
        {
            ShowChip(L10n.Tr("panel.chip.keyOff", Language), warning: true, enable: "key");
            return;
        }
        if (input.EffectWantsAudio && !input.AudioEnabled)
        {
            ShowChip(L10n.Tr("panel.chip.audioOff", Language), warning: true, enable: "audio");
            return;
        }
        if (input.EffectWantsAudio)
        {
            ShowChip(L10n.Tr("panel.chip.audio", Language), warning: false, enable: null);
            ChipLevels.Visibility = Visibility.Visible;
            PaintLevels(input.Level);
            return;
        }
        SetChipVisible(false);
    }

    void SetChipVisible(bool visible)
    {
        var target = visible ? Visibility.Visible : Visibility.Collapsed;
        if (ChipBar.Visibility != target) ChipBar.Visibility = target;
    }

    void ShowChip(string text, bool warning, string? enable)
    {
        SetChipVisible(true);
        ChipText.Text = text;
        ChipText.Foreground = warning ? PlayerTheme.WarningBrush : PlayerTheme.SecondaryBrush;
        ChipEnable.Visibility = enable is null ? Visibility.Collapsed : Visibility.Visible;
        ChipEnable.Tag = enable;
        ChipLevels.Visibility = Visibility.Collapsed;
        ChipBorder.BorderBrush = warning ? PlayerTheme.ChipWarningStrokeBrush : PlayerTheme.BorderBrush;
    }

    void PaintLevels(float level)
    {
        var bars = new[] { ChipLevel0, ChipLevel1, ChipLevel2, ChipLevel3, ChipLevel4 };
        for (var i = 0; i < bars.Length; i++)
            bars[i].Fill = level >= (i + 1) / 5f ? PlayerTheme.PrimaryBrush : PlayerTheme.BorderBrush;
    }

    void ChipEnable_Click(object sender, RoutedEventArgs e)
    {
        if (ChipEnable.Tag is "key") _controller.SetKeyReactiveEnabled(true);
        else if (ChipEnable.Tag is "audio") _controller.SetAudioEnabled(true);
        UpdateChip();
    }

    // MARK: - Selector row

    PlayerPreset? CurrentPreset =>
        _bridge.PlaySource is PlaySource.Preset p ? _controller.Presets.FirstOrDefault(x => x.Id == p.Id) : null;

    string CurrentName => CurrentPreset is { } preset
        ? PresetCatalog.DisplayName(preset, Language)
        : string.IsNullOrEmpty(_bridge.EffectName) ? L10n.Tr("panel.untitled", Language) : _bridge.EffectName;

    string SourceText => _bridge.PlaySource switch
    {
        PlaySource.Preset => L10n.Tr("panel.source.preset", Language),
        PlaySource.Web => L10n.Tr("panel.source.web", Language),
        _ => L10n.Tr("panel.source.file", Language),
    };

    void RefreshSelector(bool isPlaying, bool isPreparing)
    {
        var showsEffect = isPlaying || (isPreparing && _bridge.PlaySource is not PlaySource.None);
        var key = showsEffect
            ? $"effect|{isPlaying}|{CurrentName}|{SourceText}|{CurrentPreset?.Id}|{Language}"
            : $"choose|{Language}";
        if (key == _selectorKey) return;
        _selectorKey = key;
        SelectorRow.Children.Clear();
        _selectorSwatch = null;

        Button selector;
        if (showsEffect)
        {
            var grid = new Grid { ColumnSpacing = 12, Height = 56, Padding = new Thickness(12, 0, 12, 0) };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            IReadOnlyList<byte> rgb = (IReadOnlyList<byte>?)_poller.Frame?.Rgb ?? CurrentPreset?.Thumbnail ?? Array.Empty<byte>();
            _selectorSwatch = KeySwatch.Make(rgb, 32, 22);
            grid.Children.Add(_selectorSwatch);
            var text = new StackPanel { Spacing = 1, VerticalAlignment = VerticalAlignment.Center };
            text.Children.Add(PanelUi.Text(CurrentName, 15, PlayerTheme.TextBrush, semibold: true, wrap: false));
            text.Children.Add(PanelUi.Text(SourceText, 12, PlayerTheme.SecondaryBrush, wrap: false));
            Grid.SetColumn(text, 1);
            grid.Children.Add(text);
            var chevron = PanelUi.UpDownChevron(PlayerTheme.SecondaryBrush);
            Grid.SetColumn(chevron, 2);
            grid.Children.Add(chevron);
            selector = PanelUi.Flat(grid, OpenPicker, PlayerTheme.RaisedBrush, PlayerTheme.HoverBrush,
                PlayerTheme.BorderBrush, radius: 10);
        }
        else
        {
            var row = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Height = 44,
                HorizontalAlignment = HorizontalAlignment.Center,
            };
            var label = PanelUi.Text(L10n.Tr("panel.picker.choose", Language), 14, PlayerTheme.BackgroundBrush,
                semibold: true, wrap: false);
            label.VerticalAlignment = VerticalAlignment.Center;
            row.Children.Add(label);
            row.Children.Add(PanelUi.UpDownChevron(PlayerTheme.BackgroundBrush));
            selector = PanelUi.Flat(row, OpenPicker, PlayerTheme.TextBrush, PlayerTheme.TextHoverBrush, radius: 10);
            selector.HorizontalContentAlignment = HorizontalAlignment.Center;
        }
        AutomationName(selector, L10n.Tr("panel.picker.choose", Language));
        SelectorRow.Children.Add(selector);

        if (isPlaying)
        {
            // SF Symbols stop.fill at 11 pt: a filled 9×9 rounded square.
            var icon = new Microsoft.UI.Xaml.Shapes.Rectangle
            {
                Width = 9,
                Height = 9,
                RadiusX = 1.5,
                RadiusY = 1.5,
                Fill = PlayerTheme.SecondaryBrush,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var stop = PanelUi.Flat(icon, () => _ = _bridge.Stop(), PlayerTheme.TransparentBrush,
                PlayerTheme.HoverBrush, PlayerTheme.BorderBrush, radius: 10);
            stop.Width = 44;
            stop.Height = 56;
            stop.HorizontalContentAlignment = HorizontalAlignment.Center;
            ToolTipService.SetToolTip(stop, L10n.Tr("panel.stop", Language));
            AutomationName(stop, L10n.Tr("panel.stop", Language));
            Grid.SetColumn(stop, 1);
            SelectorRow.Children.Add(stop);
        }
    }

    static void AutomationName(UIElement element, string name) =>
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(element, name);

    // MARK: - Picker

    public void OpenPicker()
    {
        if (!ShowsSelector) return;
        var presets = _controller.Presets;
        var current = CurrentPreset;
        _highlighted = null;
        for (var i = 0; i < presets.Count; i++)
            if (presets[i].Id == current?.Id) _highlighted = i;
        _pickerOpen = true;
        Refresh();
        RootScroll.Focus(FocusState.Programmatic);
    }

    void ClosePicker()
    {
        _pickerOpen = false;
        _selectorKey = null;
        Refresh();
    }

    void BuildPicker()
    {
        PickerHost.Children.Clear();
        var header = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 6,
            Height = 36,
            Padding = new Thickness(4, 0, 4, 0),
        };
        var backIcon = PanelUi.Glyph("\uE76B", 11, PlayerTheme.SecondaryBrush, bold: true);
        backIcon.HorizontalAlignment = HorizontalAlignment.Center;
        var back = PanelUi.Flat(backIcon, ClosePicker, PlayerTheme.TransparentBrush, PlayerTheme.TransparentBrush, radius: 6);
        back.Width = 24;
        back.Height = 24;
        back.HorizontalContentAlignment = HorizontalAlignment.Center;
        back.VerticalAlignment = VerticalAlignment.Center;
        AutomationName(back, L10n.Tr("panel.picker.choose", Language));
        header.Children.Add(back);
        var title = PanelUi.Text(L10n.Tr("panel.picker.choose", Language), 13, PlayerTheme.TextBrush, semibold: true, wrap: false);
        title.VerticalAlignment = VerticalAlignment.Center;
        header.Children.Add(title);
        PickerHost.Children.Add(header);

        var state = _bridge.State;
        var active = state is PanelState.Playing or PanelState.Preparing;
        var current = CurrentPreset;
        var presets = _controller.Presets;
        for (var i = 0; i < presets.Count; i++)
            PickerHost.Children.Add(PresetRow(presets[i], i, active && current?.Id == presets[i].Id));

        PickerHost.Children.Add(PanelUi.Divider(new Thickness(8, 6, 8, 6)));
        PickerHost.Children.Add(PickerAction("\uE8A5", L10n.Tr("panel.footer.playLep", Language), "Ctrl+O", () =>
        {
            ClosePicker();
            _ = OpenLepPickerAsync();
        }));
        PickerHost.Children.Add(PickerAction(null, L10n.Tr("panel.picker.create", Language), null, _controller.OpenLibrary));
    }

    FrameworkElement PresetRow(PlayerPreset preset, int index, bool current)
    {
        var grid = new Grid { ColumnSpacing = 12, Height = 36, Padding = new Thickness(8, 0, 8, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.Children.Add(KeySwatch.Make(preset.Thumbnail, 28, 18));
        var name = PanelUi.Text(PresetCatalog.DisplayName(preset, Language), 13, PlayerTheme.TextBrush, wrap: false);
        name.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(name, 1);
        grid.Children.Add(name);
        var tags = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, VerticalAlignment = VerticalAlignment.Center };
        if (preset.HasAudio)
        {
            tags.Children.Add(PanelUi.Waveform(PlayerTheme.TertiaryBrush));
        }
        if (preset.NeedsKeys)
            tags.Children.Add(PanelUi.Glyph("\uE765", 11, PlayerTheme.TertiaryBrush));
        if (current)
            tags.Children.Add(PanelUi.Glyph("\uE73E", 11, PlayerTheme.PrimaryBrush, bold: true));
        Grid.SetColumn(tags, 2);
        grid.Children.Add(tags);

        Brush Fill() => _highlighted == index ? PlayerTheme.HoverBrush : current ? PlayerTheme.RaisedBrush : PlayerTheme.TransparentBrush;
        var row = PanelUi.Flat(grid, () => Play(preset), Fill(), Fill(), radius: 8);
        row.IsEnabled = preset.FilePath != null;
        row.Tag = index;
        row.PointerEntered += (_, _) =>
        {
            _highlighted = index;
            PaintPickerHighlight();
        };
        return row;
    }

    void PaintPickerHighlight()
    {
        var state = _bridge.State;
        var active = state is PanelState.Playing or PanelState.Preparing;
        var current = CurrentPreset;
        foreach (var child in PickerHost.Children)
        {
            if (child is not Button { Tag: int index } row) continue;
            var on = active && current?.Id == _controller.Presets[index].Id;
            row.Background = _highlighted == index ? PlayerTheme.HoverBrush : on ? PlayerTheme.RaisedBrush : PlayerTheme.TransparentBrush;
        }
    }

    /// <param name="glyph">Segoe glyph, or null for the Mac arrow.up.right.</param>
    FrameworkElement PickerAction(string? glyph, string title, string? shortcut, Action action)
    {
        var grid = new Grid { ColumnSpacing = 12, Height = 36, Padding = new Thickness(8, 0, 8, 0) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(28) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        FrameworkElement icon = glyph is null
            ? PanelUi.ArrowUpRight(12, PlayerTheme.TertiaryBrush)
            : PanelUi.Glyph(glyph, 12, PlayerTheme.TertiaryBrush);
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        grid.Children.Add(icon);
        var label = PanelUi.Text(title, 13, PlayerTheme.SecondaryBrush, wrap: false);
        label.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(label, 1);
        grid.Children.Add(label);
        if (shortcut != null)
        {
            var hint = PanelUi.Text(shortcut, 11, PlayerTheme.TertiaryBrush, wrap: false);
            hint.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(hint, 2);
            grid.Children.Add(hint);
        }
        return PanelUi.Flat(grid, action, PlayerTheme.TransparentBrush, PlayerTheme.HoverBrush, radius: 8);
    }

    void Play(PlayerPreset preset)
    {
        if (preset.FilePath is null) return;
        _pickerOpen = false;
        _selectorKey = null;
        _controller.PlayPreset(preset);
    }

    void Root_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (!_pickerOpen) return;
        var presets = _controller.Presets;
        switch (e.Key)
        {
            case VirtualKey.Up:
            case VirtualKey.Down:
                if (presets.Count == 0) break;
                var delta = e.Key == VirtualKey.Down ? 1 : -1;
                var start = _highlighted ?? (delta > 0 ? -1 : presets.Count);
                _highlighted = Math.Clamp(start + delta, 0, presets.Count - 1);
                PaintPickerHighlight();
                e.Handled = true;
                break;
            case VirtualKey.Enter:
                if (_highlighted is { } i && i >= 0 && i < presets.Count) Play(presets[i]);
                e.Handled = true;
                break;
            case VirtualKey.Escape:
                ClosePicker();
                e.Handled = true;
                break;
        }
    }

    // MARK: - Cards

    FrameworkElement? BuildCard(PanelState state, BackendIssue? issue, FailureCode? idleFailure)
    {
        if (idleFailure is { } failure) return FailureCard(failure);
        return state switch
        {
            PanelState.NeedsDriver n => NeedsDriverCard(n),
            PanelState.NoKeyboard n => NoKeyboardCard(n.DeviceLost),
            PanelState.BackendUnresponsive => BackendCard(issue ?? new BackendIssue.Unresponsive()),
            PanelState.VendorConflict v => VendorCard(v.Name),
            PanelState.Blocked => BlockedCard(),
            PanelState.CoreUnavailable => CoreUnavailableCard(),
            _ => null,
        };
    }

    string Tr(string key, params object[] args) => L10n.Tr(key, Language, args);
    TextBlock Headline(string text) => PanelUi.Text(text, 15, PlayerTheme.TextBrush, semibold: true);
    TextBlock Body(string text) => PanelUi.Text(text, 12, PlayerTheme.SecondaryBrush);
    TextBlock Caption(string text, Brush? brush = null) => PanelUi.Text(text, 11, brush ?? PlayerTheme.SecondaryBrush);
    TextBlock Footnote(string text, Brush? brush = null) => PanelUi.Text(text, 10, brush ?? PlayerTheme.SecondaryBrush);

    FrameworkElement FailureCard(FailureCode failure)
    {
        var stack = PanelUi.Stack(7);
        stack.Children.Add(Headline(Tr("panel.failure.title")));
        stack.Children.Add(Caption(Tr("panel.failure.line")));
        stack.Children.Add(Caption(Tr(failure.LocalizationKey())));
        stack.Children.Add(PanelUi.ActionRow(
            PanelUi.Primary(Tr("panel.createEffect"), _controller.OpenLibrary),
            PanelUi.Secondary(Tr("panel.backend.copyDiagnostics"), CopyDiagnostics)));
        if (_diagnosticsCopied) stack.Children.Add(Footnote(Tr("panel.backend.copied"), PlayerTheme.PrimaryBrush));
        return PanelUi.TintCard(stack, PlayerTheme.DangerFillBrush, PlayerTheme.DangerStrokeBrush);
    }

    FrameworkElement NeedsDriverCard(PanelState.NeedsDriver state)
    {
        var info = _bridge.LoadDriverInfo();
        var stack = PanelUi.Stack(9);
        stack.Children.Add(Headline(Tr("panel.needsDriver.title")));
        stack.Children.Add(Body(Tr("panel.needsDriver.body")));

        var bullets = PanelUi.Stack(5);
        if (info?.WholeMegabytes() is { } mb)
            bullets.Children.Add(PanelUi.Bullet(Tr("panel.needsDriver.bullet.summary", info.Version ?? "—", mb)));
        else
            bullets.Children.Add(PanelUi.Bullet(Tr("panel.needsDriver.bullet.versionOnly", info?.Version ?? "—")));
        bullets.Children.Add(PanelUi.Bullet(Tr("panel.needsDriver.bullet.verified")));
        bullets.Children.Add(PanelUi.Bullet(Tr("panel.needsDriver.bullet.safe")));
        stack.Children.Add(bullets);

        if (state.Progress is { } progress)
        {
            var bar = PanelUi.Stack(4);
            _driverProgress = new ProgressBar { Value = progress, Maximum = 100, Foreground = PlayerTheme.PrimaryBrush, Background = PlayerTheme.BorderBrush };
            _driverPercent = PanelUi.Text(Tr("panel.needsDriver.percent", progress), 10, PlayerTheme.SecondaryBrush, family: PlayerTheme.FontMono);
            bar.Children.Add(_driverProgress);
            bar.Children.Add(_driverPercent);
            stack.Children.Add(bar);
        }

        // Same order as Mac SetupContent.needsDriver(progress:error:verified:).
        if (state.Progress is not null)
        {
            stack.Children.Add(PanelUi.ActionRow(
                PanelUi.Primary(Tr("setup.button.installing"), null, disabled: true, pressed: true),
                PanelUi.Secondary(Tr("setup.button.cancel"), _controller.StopPlayback)));
        }
        else if (info is not { IsVerified: true })
        {
            stack.Children.Add(Caption(Tr("setup.unverified.warning"), PlayerTheme.WarningBrush));
            stack.Children.Add(Footnote(Tr("setup.unverified.external")));
            stack.Children.Add(PanelUi.ActionRow(
                PanelUi.Primary(Tr("setup.button.retry"), _controller.RetryDriver),
                PanelUi.Secondary(Tr("panel.needsDriver.later"), _controller.DeclineDriver)));
        }
        else if (state.DriverError is >= 1 and <= 3)
        {
            stack.Children.Add(Caption(Tr($"setup.failed.{state.DriverError}"), PlayerTheme.WarningBrush));
            stack.Children.Add(PanelUi.ActionRow(
                PanelUi.Primary(Tr("setup.button.tryAgain"), _controller.InstallDriver),
                PanelUi.Secondary(Tr("panel.needsDriver.later"), _controller.DeclineDriver)));
        }
        else
        {
            stack.Children.Add(PanelUi.ActionRow(
                PanelUi.Primary(Tr("panel.needsDriver.install"), _controller.InstallDriver),
                PanelUi.Secondary(Tr("panel.needsDriver.later"), _controller.DeclineDriver)));
        }
        return PanelUi.Card(stack);
    }

    FrameworkElement NoKeyboardCard(bool deviceLost)
    {
        var stack = PanelUi.Stack(9);
        if (deviceLost)
            stack.Children.Add(PanelUi.Text(Tr("panel.noKeyboard.deviceLost"), 11, PlayerTheme.WarningBrush, semibold: true));
        stack.Children.Add(Headline(Tr("panel.noKeyboard.title")));
        stack.Children.Add(Body(Tr("panel.noKeyboard.subtitle")));
        var steps = PanelUi.Stack(6);
        steps.Children.Add(PanelUi.Step(1, Tr("panel.noKeyboard.check1")));
        steps.Children.Add(PanelUi.Step(2, Tr("panel.noKeyboard.check2")));
        steps.Children.Add(PanelUi.Step(3, Tr("panel.noKeyboard.check3")));
        stack.Children.Add(steps);
        stack.Children.Add(PanelUi.ActionRow(
            PanelUi.Primary(Tr("panel.noKeyboard.findAgain"), _controller.Retry),
            PanelUi.Secondary(Tr("panel.noKeyboard.supported"), _controller.OpenSupportedKeyboards)));
        stack.Children.Add(Footnote(Tr("panel.noKeyboard.footer"), PlayerTheme.TertiaryBrush));
        return PanelUi.Card(stack);
    }

    FrameworkElement BackendCard(BackendIssue issue)
    {
        var stack = PanelUi.Stack(9);
        switch (issue)
        {
            case BackendIssue.Restarting r:
                stack.Children.Add(Headline(Tr("panel.backend.restarting.title")));
                stack.Children.Add(Body(Tr("panel.backend.restarting.body", r.Attempt, r.Limit)));
                stack.Children.Add(new ProgressRing { Width = 16, Height = 16, IsActive = true, HorizontalAlignment = HorizontalAlignment.Left });
                stack.Children.Add(PanelUi.ActionRow(PanelUi.Secondary(Tr("panel.backend.copyDiagnostics"), CopyDiagnostics), null));
                break;
            case BackendIssue.GaveUp:
                var crashes = Math.Max(1, _bridge.LoadDriverInfo()?.Supervision?.Crashes ?? 1);
                stack.Children.Add(Headline(Tr("panel.backend.gaveUp.title")));
                stack.Children.Add(Body(Tr("panel.backend.gaveUp.body", crashes)));
                stack.Children.Add(PanelUi.ActionRow(
                    PanelUi.Primary(Tr("panel.backend.restart"), _controller.RestartBackend),
                    PanelUi.Secondary(Tr("panel.backend.copyDiagnostics"), CopyDiagnostics)));
                break;
            case BackendIssue.ExternalLost lost:
                stack.Children.Add(Headline(Tr("panel.backend.external.title")));
                // Plain digits: a port is not a quantity (the Mac's String(port)).
                stack.Children.Add(Body(Tr("panel.backend.external.body", lost.Port.ToString(System.Globalization.CultureInfo.InvariantCulture))));
                var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 7 };
                waiting.Children.Add(new ProgressRing { Width = 12, Height = 12, IsActive = true });
                waiting.Children.Add(Caption(Tr("panel.backend.waiting")));
                stack.Children.Add(waiting);
                stack.Children.Add(PanelUi.ActionRow(
                    PanelUi.Primary(Tr("panel.backend.retryNow"), _controller.Retry),
                    PanelUi.Secondary(Tr("panel.backend.copyDiagnostics"), CopyDiagnostics)));
                break;
            default:
                stack.Children.Add(Headline(Tr("panel.backend.unresponsive.title")));
                stack.Children.Add(Body(Tr("panel.backend.unresponsive.body")));
                stack.Children.Add(PanelUi.ActionRow(
                    PanelUi.Primary(Tr("panel.backend.restart"), _controller.RestartBackend),
                    PanelUi.Secondary(Tr("panel.backend.copyDiagnostics"), CopyDiagnostics)));
                break;
        }
        if (_diagnosticsCopied) stack.Children.Add(Footnote(Tr("panel.backend.copied"), PlayerTheme.PrimaryBrush));
        return PanelUi.Card(stack);
    }

    FrameworkElement VendorCard(string? name)
    {
        var display = string.IsNullOrEmpty(name) ? Tr("panel.vendor.fallbackName") : name;
        var stack = PanelUi.Stack(9);
        stack.Children.Add(Headline(Tr("panel.vendor.title", display)));
        stack.Children.Add(Body(Tr("panel.vendor.body")));
        var steps = PanelUi.Stack(6);
        steps.Children.Add(PanelUi.Step(1, Tr("panel.vendor.step1", display)));
        steps.Children.Add(PanelUi.Step(2, Tr("panel.vendor.step2")));
        steps.Children.Add(PanelUi.Step(3, Tr("panel.vendor.step3")));
        stack.Children.Add(steps);
        stack.Children.Add(PanelUi.ActionRow(
            PanelUi.Primary(Tr("panel.vendor.retry"), _controller.Retry),
            PanelUi.Secondary(Tr("panel.vendor.openTaskManager"), _controller.OpenTaskManager)));
        stack.Children.Add(PanelUi.Link(
            Tr(_diagnosticsCopied ? "panel.backend.copied" : "panel.backend.copyDiagnostics"), 11, CopyDiagnostics));
        return PanelUi.Card(stack);
    }

    FrameworkElement BlockedCard()
    {
        var stack = PanelUi.Stack(9);
        stack.Children.Add(Headline(Tr("panel.blocked.title")));
        stack.Children.Add(Body(Tr("panel.blocked.line")));
        // Mac stacks a second "查看步骤" button that opens its setup window;
        // Windows has no setup window, so only the retry button remains.
        stack.Children.Add(PanelUi.ActionRow(PanelUi.Primary(Tr("panel.blocked.retry"), _controller.Retry), null));
        return PanelUi.Card(stack);
    }

    FrameworkElement CoreUnavailableCard()
    {
        var stack = PanelUi.Stack(9);
        stack.Children.Add(PanelUi.Text(Tr("panel.coreUnavailable.title"), 13, PlayerTheme.TextBrush, semibold: true));
        stack.Children.Add(Caption(Tr("panel.coreUnavailable.body")));
        return PanelUi.Card(stack);
    }

    void CopyDiagnostics()
    {
        if (!_controller.CopyDiagnosticsToClipboard()) return;
        _diagnosticsCopied = true;
        _cardKey = null;
        Refresh();
        _copiedTimer?.Stop();
        var timer = _copiedTimer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(2);
        timer.IsRepeating = false;
        timer.Tick += (_, _) =>
        {
            _diagnosticsCopied = false;
            _cardKey = null;
            Refresh();
        };
        timer.Start();
    }

    // MARK: - Header, menu and shortcuts

    void ApplyShellTheme()
    {
        RootGrid.RequestedTheme = ElementTheme.Dark;
        RootGrid.Background = PlayerTheme.BackgroundBrush;
        var mark = Path.Combine(AppContext.BaseDirectory, "Assets", "PanelMark.png");
        if (File.Exists(mark)) PanelMark.Source = new BitmapImage(new Uri(mark));
        StyleText(AppNameText, 13, PlayerTheme.TextBrush, semibold: true);
        StyleText(StatusText, 12, PlayerTheme.SecondaryBrush);
        HeroCard.Background = PlayerTheme.InsetBrush;
        HeroCard.BorderBrush = PlayerTheme.BorderBrush;
        HeroIdleIcon.Foreground = PlayerTheme.TertiaryBrush;
        StyleText(HeroIdleText, 12, PlayerTheme.SecondaryBrush);
        StyleText(HeroPreparingText, 12, PlayerTheme.SecondaryBrush);
        StyleText(HeroDropHint, 13, PlayerTheme.TextBrush, semibold: true);
        StyleText(ChipText, 11, PlayerTheme.SecondaryBrush);
        StyleText(ChipEnableText, 11, PlayerTheme.TextBrush);
        ChipBorder.Background = PlayerTheme.RaisedBrush;
        StyleText(StoppedHint, 11, PlayerTheme.TertiaryBrush);
        StyleText(ConflictHint, 11, PlayerTheme.TertiaryBrush);
        DropOutline.BorderBrush = PlayerTheme.DropOutlineBrush;
    }

    static void StyleText(TextBlock block, double size, Brush brush, bool semibold = false)
    {
        block.FontFamily = semibold ? PlayerTheme.FontSemibold : PlayerTheme.FontRegular;
        block.FontSize = size;
        block.Foreground = brush;
        if (semibold) block.FontWeight = PlayerTheme.SemiBold;
    }

    /// <summary>Ctrl+O / Ctrl+, / Ctrl+Q, the Windows form of the Mac ⌘O / ⌘, / ⌘Q.</summary>
    void AddShortcuts()
    {
        void Add(VirtualKey key, Action action)
        {
            var accelerator = new KeyboardAccelerator { Key = key, Modifiers = VirtualKeyModifiers.Control };
            accelerator.Invoked += (_, e) => { e.Handled = true; action(); };
            RootGrid.KeyboardAccelerators.Add(accelerator);
        }
        Add(VirtualKey.O, () => _ = OpenLepPickerAsync());
        Add((VirtualKey)188, _controller.OpenSettings); // VK_OEM_COMMA
        Add(VirtualKey.Q, _controller.Quit);
        RootGrid.KeyboardAcceleratorPlacementMode = KeyboardAcceleratorPlacementMode.Hidden;
    }

    void ShowMoreMenu()
    {
        var menu = new MenuFlyout();
        menu.Items.Add(Item(Tr("panel.footer.playLep"), "Ctrl+O", () => _ = OpenLepPickerAsync()));
        menu.Items.Add(Item(Tr("panel.footer.settings"), "Ctrl+,", _controller.OpenSettings));
        if (!ProtocolRegistrationService.IsRegistered())
        {
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(Item(Tr("panel.footer.defaultHandler"), null, _controller.MakeDefaultHandler));
        }

        var keyboards = _controller.Keyboards();
        if (keyboards.Count > 1)
        {
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(new MenuFlyoutItem { Text = Tr("panel.keyboards.header"), IsEnabled = false });
            var current = _bridge.KeyboardName;
            foreach (var keyboard in keyboards)
            {
                var title = ShortKeyboardName(keyboard);
                var item = new ToggleMenuFlyoutItem
                {
                    Text = title.Length == 0 ? keyboard : title,
                    IsChecked = keyboard == current,
                };
                item.Click += (_, _) => _controller.SelectKeyboard(keyboard);
                menu.Items.Add(item);
            }
        }

        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(Item(Tr("panel.footer.quit"), "Ctrl+Q", _controller.Quit));
        menu.ShowAt(_moreButton, new Microsoft.UI.Xaml.Controls.Primitives.FlyoutShowOptions
        {
            Placement = Microsoft.UI.Xaml.Controls.Primitives.FlyoutPlacementMode.BottomEdgeAlignedRight,
        });
    }

    static MenuFlyoutItem Item(string text, string? shortcut, Action click)
    {
        var item = new MenuFlyoutItem { Text = text };
        if (shortcut != null) item.KeyboardAcceleratorTextOverride = shortcut;
        item.Click += (_, _) => click();
        return item;
    }

    async System.Threading.Tasks.Task OpenLepPickerAsync()
    {
        var picker = new FileOpenPicker();
        InitializeWithWindow.Initialize(picker, Hwnd);
        picker.FileTypeFilter.Add(".lep");
        picker.SuggestedStartLocation = PickerLocationId.Downloads;
        var file = await picker.PickSingleFileAsync();
        if (file != null)
            _controller.OpenLepPath(file.Path);
    }

    static void ApplyCustomChrome(Microsoft.UI.Windowing.AppWindow appWindow)
    {
        if (appWindow.Presenter is not Microsoft.UI.Windowing.OverlappedPresenter presenter) return;
        presenter.IsResizable = false;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        // No system caption: the header draws the Mac ⋯ / × tiles. Keep the thin border.
        presenter.SetBorderAndTitleBar(hasBorder: true, hasTitleBar: false);
    }

    // MARK: - Drag and drop

    void Root_DragOver(object sender, DragEventArgs e)
    {
        if (!HasLep(e)) return;
        e.AcceptedOperation = DataPackageOperation.Copy;
        if (!_dropTargeted)
        {
            _dropTargeted = true;
            Refresh();
        }
        e.Handled = true;
    }

    void Root_DragLeave(object sender, DragEventArgs e)
    {
        if (!_dropTargeted) return;
        _dropTargeted = false;
        Refresh();
    }

    async void Root_Drop(object sender, DragEventArgs e)
    {
        _dropTargeted = false;
        var path = await FirstLepPath(e);
        Refresh();
        if (path != null)
            _controller.OpenLepPath(path);
    }

    static bool HasLep(DragEventArgs e) =>
        e.DataView.Contains(StandardDataFormats.StorageItems);

    static async System.Threading.Tasks.Task<string?> FirstLepPath(DragEventArgs e)
    {
        if (!e.DataView.Contains(StandardDataFormats.StorageItems)) return null;
        var items = await e.DataView.GetStorageItemsAsync();
        return items.OfType<StorageFile>()
            .FirstOrDefault(f => f.FileType.Equals(".lep", StringComparison.OrdinalIgnoreCase))
            ?.Path;
    }

}
