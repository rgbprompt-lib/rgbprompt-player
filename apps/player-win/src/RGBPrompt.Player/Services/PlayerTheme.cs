using System.Runtime.InteropServices;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace RGBPrompt.Player;

/// <summary>
/// Palette and type scale from the Mac Player <c>Theme</c> / <c>Typography</c>
/// (board 3.5). Space Grotesk is used for Latin; Chinese falls back to the
/// system UI face (Microsoft YaHei UI).
/// </summary>
public static class PlayerTheme
{
    public static readonly Color Background = Argb(0x151922);
    public static readonly Color WindowBackground = Argb(0x0E1118);
    public static readonly Color Inset = Argb(0x0B0D12);
    public static readonly Color Border = Argb(0x232835);
    public static readonly Color Control = Argb(0x3A4150);
    public static readonly Color Raised = Argb(0x1B202B);
    public static readonly Color Hover = Argb(0x222835);
    public static readonly Color Primary = Argb(0x2EE59D);
    public static readonly Color PrimaryPressed = Argb(0x1E8E62);
    public static readonly Color Text = Argb(0xF4F6FA);
    public static readonly Color Secondary = Argb(0x9AA3B2);
    public static readonly Color Tertiary = Argb(0x7D8597);
    public static readonly Color Info = Argb(0x6FA8FF);
    public static readonly Color Warning = Argb(0xFFA43A);
    public static readonly Color Danger = Argb(0xFF6B84);
    public static readonly Color StepIndex = Argb(0x1E2330);
    public static readonly Color KeyBase = Argb(0x12161F);
    public static readonly Color KeyIdle = Argb(0x1A1F2A);
    public static readonly Color KeyOutline = Argb(0x262C39);
    public static readonly Color OnPrimary = Background;

    public static readonly SolidColorBrush BackgroundBrush = Brush(Background);
    public static readonly SolidColorBrush WindowBackgroundBrush = Brush(WindowBackground);
    public static readonly SolidColorBrush InsetBrush = Brush(Inset);
    public static readonly SolidColorBrush BorderBrush = Brush(Border);
    public static readonly SolidColorBrush RaisedBrush = Brush(Raised);
    public static readonly SolidColorBrush HoverBrush = Brush(Hover);
    public static readonly SolidColorBrush PrimaryBrush = Brush(Primary);
    public static readonly SolidColorBrush TextBrush = Brush(Text);
    public static readonly SolidColorBrush SecondaryBrush = Brush(Secondary);
    public static readonly SolidColorBrush TertiaryBrush = Brush(Tertiary);
    public static readonly SolidColorBrush WarningBrush = Brush(Warning);
    public static readonly SolidColorBrush DangerBrush = Brush(Danger);
    public static readonly SolidColorBrush OnPrimaryBrush = Brush(OnPrimary);
    public static readonly SolidColorBrush ControlBrush = Brush(Control);
    public static readonly SolidColorBrush StepIndexBrush = Brush(StepIndex);
    public static readonly SolidColorBrush InfoBrush = Brush(Info);
    public static readonly SolidColorBrush PrimaryPressedBrush = Brush(PrimaryPressed);
    /// <summary>Mac <c>Theme.text.opacity(0.9)</c>: hover fill of the white "选择灯效" button.</summary>
    public static readonly SolidColorBrush TextHoverBrush = new(Color.FromArgb(230, 0xF4, 0xF6, 0xFA));
    public static readonly SolidColorBrush ScrimBrush = new(Color.FromArgb(140, 0x0B, 0x0D, 0x12));
    public static readonly SolidColorBrush DropScrimBrush = new(Color.FromArgb(199, 0x0B, 0x0D, 0x12));
    public static readonly SolidColorBrush DropOutlineBrush = new(Color.FromArgb(140, 0xF4, 0xF6, 0xFA));
    public static readonly SolidColorBrush SwatchStrokeBrush = new(Color.FromArgb(20, 0xF4, 0xF6, 0xFA));
    public static readonly SolidColorBrush DangerFillBrush = new(Color.FromArgb(26, 0xFF, 0x6B, 0x84));
    public static readonly SolidColorBrush DangerStrokeBrush = new(Color.FromArgb(115, 0xFF, 0x6B, 0x84));
    public static readonly SolidColorBrush WarningFillBrush = new(Color.FromArgb(31, 0xFF, 0xA4, 0x3A));
    public static readonly SolidColorBrush WarningStrokeBrush = new(Color.FromArgb(115, 0xFF, 0xA4, 0x3A));
    public static readonly SolidColorBrush ChipWarningStrokeBrush = new(Color.FromArgb(89, 0xFF, 0xA4, 0x3A));
    public static readonly SolidColorBrush CardBrush = new SolidColorBrush(Color.FromArgb(10, 0xF4, 0xF6, 0xFA));
    public static readonly SolidColorBrush TransparentBrush = new SolidColorBrush(Color.FromArgb(0, 0, 0, 0));

    public const int PanelWidth = 340;
    /// <summary>Upper bound only: the panel sizes to its content like the Mac panel.</summary>
    public const int PanelMaxHeight = 720;
    public const int SettingsWidth = 400;
    /// <summary>Mac settings content (400×560) under our own 32-DIP title bar.</summary>
    public const int SettingsContentHeight = 560;
    public const int SettingsTitleBarHeight = 32;
    public const double HeaderHeight = 48;
    public const double PrimaryButtonHeight = 44;
    public const double PresetRowHeight = 36;
    public const double CornerRadius = 10;

    public static FontFamily FontRegular { get; private set; } = new("Segoe UI Variable, Microsoft YaHei UI, Segoe UI");
    public static FontFamily FontSemibold { get; private set; } = FontRegular;
    /// <summary>Mac <c>.system(size:, design: .monospaced)</c> for the brightness value.</summary>
    public static FontFamily FontMono { get; } = new("Cascadia Mono, Consolas");
    public static FontFamily FontIcons { get; } = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    public static void Ensure()
    {
        if (_ready) return;
        _ready = true;
        TryRegisterFonts();
    }

    static void TryRegisterFonts()
    {
        try
        {
            var dir = Path.Combine(AppContext.BaseDirectory, "Fonts");
            foreach (var file in new[]
            {
                "SpaceGrotesk-Regular.ttf",
                "SpaceGrotesk-Medium.ttf",
                "SpaceGrotesk-SemiBold.ttf",
                "SpaceGrotesk-Bold.ttf",
            })
            {
                var path = Path.Combine(dir, file);
                if (File.Exists(path))
                    AddFontResourceEx(path, FrPrivate, IntPtr.Zero);
            }
            // XAML text is DirectWrite and does not see GDI private fonts, so
            // name the shipped files directly (one face per weight, like the
            // Mac Typography.sans(_, weight)). Space Grotesk has no CJK;
            // YaHei/Segoe cover Chinese.
            if (File.Exists(Path.Combine(dir, "SpaceGrotesk-Regular.ttf")))
                FontRegular = new FontFamily("ms-appx:///Fonts/SpaceGrotesk-Regular.ttf#Space Grotesk, Microsoft YaHei UI, Segoe UI");
            if (File.Exists(Path.Combine(dir, "SpaceGrotesk-SemiBold.ttf")))
                FontSemibold = new FontFamily("ms-appx:///Fonts/SpaceGrotesk-SemiBold.ttf#Space Grotesk, Microsoft YaHei UI Bold, Microsoft YaHei UI, Segoe UI");
            else
                FontSemibold = FontRegular;
        }
        catch
        {
            // Keep the system stack.
        }
    }

    public static Windows.UI.Text.FontWeight SemiBold => FontWeights.SemiBold;

    static Color Argb(uint rgb) => Color.FromArgb(
        255,
        (byte)((rgb >> 16) & 0xFF),
        (byte)((rgb >> 8) & 0xFF),
        (byte)(rgb & 0xFF));

    static SolidColorBrush Brush(Color color) => new(color);

    const uint FrPrivate = 0x10;

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    static extern int AddFontResourceEx(string name, uint fl, IntPtr res);

    static bool _ready;
}
