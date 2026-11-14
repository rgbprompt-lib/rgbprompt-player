using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace RGBPrompt.Player.Views;

/// <summary>
/// Building blocks shared by the panel and settings windows, one per Mac view
/// helper (PanelViews.swift / SettingsViews.swift): text styles, the flat
/// button styles with hover, cards, step and bullet rows, the segmented
/// control and the 34×20 toggle.
/// </summary>
static class PanelUi
{
    static Style FlatStyle => (Style)Application.Current.Resources["FlatButton"];

    public static TextBlock Text(string text, double size, Brush? brush = null, bool semibold = false,
        bool wrap = true, FontFamily? family = null)
    {
        var block = new TextBlock
        {
            Text = text,
            FontSize = size,
            FontFamily = family ?? (semibold ? PlayerTheme.FontSemibold : PlayerTheme.FontRegular),
            Foreground = brush ?? PlayerTheme.SecondaryBrush,
            TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap,
            TextTrimming = wrap ? TextTrimming.None : TextTrimming.CharacterEllipsis,
            // YaHei's default line box is taller than PingFang/SF on the Mac;
            // pin it to ~1.3× so rows keep the Mac heights.
            LineHeight = Math.Round(size * 1.3),
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
        };
        if (semibold) block.FontWeight = PlayerTheme.SemiBold;
        return block;
    }

    public static FontIcon Glyph(string glyph, double size, Brush brush, bool bold = false) => new()
    {
        Glyph = glyph,
        FontFamily = PlayerTheme.FontIcons,
        FontSize = size,
        Foreground = brush,
        FontWeight = bold ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.Normal,
        IsHitTestVisible = false,
    };

    /// <summary>SF Symbols <c>chevron.up.chevron.down</c>, drawn as two small chevrons.</summary>
    public static FrameworkElement UpDownChevron(Brush brush) => new StackPanel
    {
        Spacing = -3,
        VerticalAlignment = VerticalAlignment.Center,
        IsHitTestVisible = false,
        Children =
        {
            Glyph("\uE70E", 8, brush, bold: true),
            Glyph("\uE70D", 8, brush, bold: true),
        },
    };

    /// <summary>SF Symbols <c>waveform</c> at 11 pt: seven thin centred bars.</summary>
    public static FrameworkElement Waveform(Brush brush)
    {
        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = 0.6,
            Height = 12,
            VerticalAlignment = VerticalAlignment.Center,
            IsHitTestVisible = false,
        };
        foreach (var h in new[] { 3.0, 6, 9, 11, 6, 9, 3 })
            row.Children.Add(new Rectangle
            {
                Width = 1.1,
                Height = h,
                RadiusX = 0.55,
                RadiusY = 0.55,
                Fill = brush,
                VerticalAlignment = VerticalAlignment.Center,
            });
        return row;
    }

    /// <summary>SF Symbols <c>arrow.up.right</c>.</summary>
    public static TextBlock ArrowUpRight(double size, Brush brush) => new()
    {
        Text = "\u2197",
        FontFamily = new FontFamily("Segoe UI Symbol"),
        FontSize = size,
        Foreground = brush,
        IsHitTestVisible = false,
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
    };

    /// <summary>
    /// Mac <c>PanelRowStyle</c> / <c>HeaderIconChrome</c>: flat fill, a hover
    /// fill and stroke, and a pressed fill. No Fluent reveal or scaling.
    /// </summary>
    public static Button Flat(object content, Action? click, Brush fill, Brush hoverFill,
        Brush? stroke = null, Brush? hoverStroke = null, double radius = 10, Brush? pressedFill = null)
    {
        var button = new Button
        {
            Style = FlatStyle,
            Content = content,
            Background = fill,
            BorderBrush = stroke ?? PlayerTheme.TransparentBrush,
            BorderThickness = new Thickness(stroke is null ? 0 : 1),
            CornerRadius = new CornerRadius(radius),
        };
        var hovering = false;
        void Paint(bool pressed)
        {
            button.Background = pressed && pressedFill != null ? pressedFill : hovering ? hoverFill : fill;
            if (stroke != null) button.BorderBrush = hovering && hoverStroke != null ? hoverStroke : stroke;
        }
        button.PointerEntered += (_, _) => { hovering = true; Paint(false); };
        button.PointerExited += (_, _) => { hovering = false; Paint(false); };
        button.PointerCanceled += (_, _) => { hovering = false; Paint(false); };
        button.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, _) => Paint(true)), true);
        button.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler((_, _) => Paint(false)), true);
        button.IsEnabledChanged += (_, _) => button.Opacity = button.IsEnabled ? 1 : 0.5;
        if (click != null) button.Click += (_, _) => click();
        return button;
    }

    /// <summary>⋯ and × in the panel header: 26×26 soft tiles, radius 7.</summary>
    public static Button HeaderIcon(string glyph, double size, Action click)
    {
        var icon = Glyph(glyph, size, PlayerTheme.SecondaryBrush, bold: true);
        icon.HorizontalAlignment = HorizontalAlignment.Center;
        icon.VerticalAlignment = VerticalAlignment.Center;
        var button = Flat(icon, click, PlayerTheme.RaisedBrush, PlayerTheme.HoverBrush,
            PlayerTheme.BorderBrush, PlayerTheme.ControlBrush, radius: 7, pressedFill: PlayerTheme.BorderBrush);
        button.Width = 26;
        button.Height = 26;
        button.HorizontalAlignment = HorizontalAlignment.Left;
        button.HorizontalContentAlignment = HorizontalAlignment.Center;
        return button;
    }

    /// <summary>Mac panel <c>primaryButton</c>: 12 semibold on primary, 7 vertical padding, radius 8.</summary>
    public static Button Primary(string title, Action? click, bool disabled = false, bool pressed = false)
    {
        var label = Text(title, 12, PlayerTheme.OnPrimaryBrush, semibold: true, wrap: false);
        label.HorizontalAlignment = HorizontalAlignment.Center;
        label.TextAlignment = TextAlignment.Center;
        var fill = pressed ? PlayerTheme.PrimaryPressedBrush : PlayerTheme.PrimaryBrush;
        var button = Flat(label, click, fill, fill, radius: 8, pressedFill: PlayerTheme.PrimaryPressedBrush);
        button.Padding = new Thickness(8, 7, 8, 7);
        button.HorizontalContentAlignment = HorizontalAlignment.Center;
        button.IsEnabled = !disabled;
        if (disabled) button.Opacity = 1; // Mac keeps "正在安装…" at full strength.
        return button;
    }

    /// <summary>Mac panel <c>secondaryButton</c>: 12 regular text, 1 px control stroke, radius 8.</summary>
    public static Button Secondary(string title, Action? click)
    {
        var label = Text(title, 12, PlayerTheme.TextBrush, wrap: false);
        label.HorizontalAlignment = HorizontalAlignment.Center;
        label.TextAlignment = TextAlignment.Center;
        var button = Flat(label, click, PlayerTheme.TransparentBrush, PlayerTheme.TransparentBrush,
            PlayerTheme.ControlBrush, radius: 8);
        button.Padding = new Thickness(8, 6, 8, 6);
        button.HorizontalContentAlignment = HorizontalAlignment.Center;
        return button;
    }

    /// <summary>Two equal-width buttons, 8 apart (Mac <c>HStack(spacing: 8)</c> of maxWidth buttons).</summary>
    public static Grid ActionRow(Button first, Button? second)
    {
        var grid = new Grid { ColumnSpacing = 8 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(first);
        if (second != null)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(second, 1);
            grid.Children.Add(second);
        }
        return grid;
    }

    /// <summary>Accent text link (Mac <c>.buttonStyle(.plain)</c> + <c>Theme.accent</c>).</summary>
    public static Button Link(string title, double size, Action click)
    {
        var label = Text(title, size, PlayerTheme.InfoBrush, wrap: false);
        var button = Flat(label, click, PlayerTheme.TransparentBrush, PlayerTheme.TransparentBrush, radius: 4);
        button.HorizontalAlignment = HorizontalAlignment.Left;
        button.PointerEntered += (_, _) => label.TextDecorations = Windows.UI.Text.TextDecorations.Underline;
        button.PointerExited += (_, _) => label.TextDecorations = Windows.UI.Text.TextDecorations.None;
        return button;
    }

    /// <summary>Mac <c>panelCard()</c>: 11 padding, text at 4 %, 1 px border, radius 10.</summary>
    public static Border Card(UIElement content) => new()
    {
        Child = content,
        Padding = new Thickness(11),
        CornerRadius = new CornerRadius(10),
        Background = PlayerTheme.CardBrush,
        BorderBrush = PlayerTheme.BorderBrush,
        BorderThickness = new Thickness(1),
    };

    /// <summary>Mac failure / notice cards: 9 padding, radius 8, tinted fill and stroke.</summary>
    public static Border TintCard(UIElement content, Brush fill, Brush stroke) => new()
    {
        Child = content,
        Padding = new Thickness(9),
        CornerRadius = new CornerRadius(8),
        Background = fill,
        BorderBrush = stroke,
        BorderThickness = new Thickness(1),
    };

    public static StackPanel Stack(double spacing) => new() { Spacing = spacing };

    /// <summary>4 px primary dot + 10 pt secondary line (Mac <c>bulletRow</c>).</summary>
    public static FrameworkElement Bullet(string text)
    {
        var grid = new Grid { ColumnSpacing = 6 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(new Ellipse
        {
            Width = 4,
            Height = 4,
            Fill = PlayerTheme.PrimaryBrush,
            VerticalAlignment = VerticalAlignment.Center,
        });
        var line = Text(text, 10, PlayerTheme.SecondaryBrush, wrap: false);
        Grid.SetColumn(line, 1);
        grid.Children.Add(line);
        return grid;
    }

    /// <summary>Numbered step: 15×15 step-index box (radius 4, accent 10 semibold) + 11 pt text.</summary>
    public static FrameworkElement Step(int number, string text)
    {
        var grid = new Grid { ColumnSpacing = 7 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var index = Text(number.ToString(), 10, PlayerTheme.InfoBrush, semibold: true, wrap: false);
        index.HorizontalAlignment = HorizontalAlignment.Center;
        index.VerticalAlignment = VerticalAlignment.Center;
        grid.Children.Add(new Border
        {
            Width = 15,
            Height = 15,
            CornerRadius = new CornerRadius(4),
            Background = PlayerTheme.StepIndexBrush,
            VerticalAlignment = VerticalAlignment.Top,
            Child = index,
        });
        var line = Text(text, 11, PlayerTheme.SecondaryBrush);
        Grid.SetColumn(line, 1);
        grid.Children.Add(line);
        return grid;
    }

    public static Rectangle Divider(Thickness margin) => new()
    {
        Height = 1,
        Fill = PlayerTheme.BorderBrush,
        Margin = margin,
        HorizontalAlignment = HorizontalAlignment.Stretch,
    };

    /// <summary>Mac settings <c>Segmented</c>: inset track (radius 7) with step-index selection (radius 5).</summary>
    public static Border Segmented<T>(IReadOnlyList<(T Id, string Title)> options, T selected, Action<T> choose)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 2 };
        foreach (var (id, title) in options)
        {
            var on = EqualityComparer<T>.Default.Equals(id, selected);
            var label = Text(title, 12, on ? PlayerTheme.TextBrush : PlayerTheme.SecondaryBrush, wrap: false);
            var fill = on ? PlayerTheme.StepIndexBrush : PlayerTheme.TransparentBrush;
            var button = Flat(label, () => choose(id), fill, fill, radius: 5);
            button.Padding = new Thickness(10, 3, 10, 3);
            button.HorizontalAlignment = HorizontalAlignment.Left;
            if (!on)
            {
                button.PointerEntered += (_, _) => label.Foreground = PlayerTheme.TextBrush;
                button.PointerExited += (_, _) => label.Foreground = PlayerTheme.SecondaryBrush;
            }
            row.Children.Add(button);
        }
        return new Border
        {
            Child = row,
            Padding = new Thickness(2),
            CornerRadius = new CornerRadius(7),
            Background = PlayerTheme.InsetBrush,
            BorderBrush = PlayerTheme.BorderBrush,
            BorderThickness = new Thickness(1),
            VerticalAlignment = VerticalAlignment.Center,
        };
    }

    /// <summary>Mac settings <c>ToggleSwitch</c>: 34×20 capsule, 16 px knob, primary when on.</summary>
    public static Button Toggle(bool isOn, bool isEnabled, Action toggle)
    {
        var knob = new Ellipse
        {
            Width = 16,
            Height = 16,
            Fill = PlayerTheme.TextBrush,
            Margin = new Thickness(2),
            HorizontalAlignment = isOn ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
        };
        var track = new Grid { Width = 34, Height = 20 };
        track.Children.Add(knob);
        var fill = isOn ? PlayerTheme.PrimaryBrush : PlayerTheme.ControlBrush;
        var button = Flat(track, toggle, fill, fill, radius: 10);
        button.Width = 34;
        button.Height = 20;
        button.HorizontalAlignment = HorizontalAlignment.Right;
        button.IsEnabled = isEnabled;
        return button;
    }

    public static Color WithAlpha(Color color, byte alpha) => Color.FromArgb(alpha, color.R, color.G, color.B);
}
