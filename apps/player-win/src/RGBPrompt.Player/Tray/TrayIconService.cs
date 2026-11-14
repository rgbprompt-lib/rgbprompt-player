using H.NotifyIcon;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media.Imaging;
using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player.Tray;

public sealed class TrayIconService : IDisposable
{
    readonly TaskbarIcon _icon;
    string _language;
    StatusBadge _badge;

    public TrayIconService(Action onToggle, Action onOpenSettings, Action onQuit, string language)
    {
        _language = language;
        _icon = new TaskbarIcon { ToolTipText = L10n.Tr("app.name", _language) };
        try
        {
            var ico = Path.Combine(AppContext.BaseDirectory, "Assets", "tray.ico");
            if (File.Exists(ico))
                _icon.IconSource = new BitmapImage(new Uri(ico));
        }
        catch { /* optional */ }

        var menu = new MenuFlyout();
        var openItem = new MenuFlyoutItem { Text = L10n.Tr("tray.openPanel", _language) };
        openItem.Click += (_, _) => onToggle();
        var settingsItem = new MenuFlyoutItem { Text = L10n.Tr("panel.footer.settings", _language) };
        settingsItem.Click += (_, _) => onOpenSettings();
        var quitItem = new MenuFlyoutItem { Text = L10n.Tr("panel.footer.quit", _language) };
        quitItem.Click += (_, _) => onQuit();
        menu.Items.Add(openItem);
        menu.Items.Add(settingsItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(quitItem);
        _icon.ContextFlyout = menu;

        // Left click toggles the panel (same as Mac status-item click).
        _icon.LeftClickCommand = new XamlUICommand();
        ((XamlUICommand)_icon.LeftClickCommand).ExecuteRequested += (_, _) => onToggle();
    }

    public void Show() => _icon.ForceCreate();

    public void UpdateBadge(StatusBadge badge)
    {
        _badge = badge;
        _icon.ToolTipText = badge switch
        {
            StatusBadge.Playing => L10n.Tr("tray.tooltip.playing", _language),
            StatusBadge.Attention => L10n.Tr("tray.tooltip.attention", _language),
            _ => L10n.Tr("app.name", _language),
        };
    }

    public void SetLanguage(string language)
    {
        _language = language;
        if (_icon.ContextFlyout is MenuFlyout menu)
        {
            if (menu.Items.Count >= 4
                && menu.Items[0] is MenuFlyoutItem open
                && menu.Items[1] is MenuFlyoutItem settings
                && menu.Items[3] is MenuFlyoutItem quit)
            {
                open.Text = L10n.Tr("tray.openPanel", _language);
                settings.Text = L10n.Tr("panel.footer.settings", _language);
                quit.Text = L10n.Tr("panel.footer.quit", _language);
            }
        }
        UpdateBadge(_badge);
    }

    public void Dispose() => _icon.Dispose();
}
