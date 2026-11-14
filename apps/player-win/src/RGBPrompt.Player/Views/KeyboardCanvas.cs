using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.UI;

namespace RGBPrompt.Player.Views;

/// <summary>
/// Generic 104-key preview. Colours come only from <c>rgbp_preview_frame</c>
/// (WYSIWYG engine output, no extra ornament).
/// </summary>
public sealed class KeyboardCanvas : Canvas
{
    static readonly Color KeyBase = Color.FromArgb(255, 0x12, 0x16, 0x1F);
    static readonly Color KeyIdle = Color.FromArgb(255, 0x1A, 0x1F, 0x2A);
    static readonly Color KeyOutline = Color.FromArgb(255, 0x26, 0x2C, 0x39);

    readonly Rectangle[] _caps;
    readonly SolidColorBrush _idleFill = new(KeyIdle);
    readonly SolidColorBrush _idleStroke = new(KeyOutline);
    readonly SolidColorBrush _baseFill = new(KeyBase);
    byte[] _rgb = [];
    bool _outline = true;

    public KeyboardCanvas()
    {
        IsHitTestVisible = false;
        _caps = new Rectangle[KeyLayout.Keys.Length];
        for (var i = 0; i < _caps.Length; i++)
        {
            var cap = new Rectangle { StrokeThickness = 1 };
            _caps[i] = cap;
            Children.Add(cap);
        }
        SizeChanged += (_, _) => LayoutKeys();
        Loaded += (_, _) => LayoutKeys();
    }

    public void SetFrame(byte[]? rgb, bool outline)
    {
        _rgb = rgb ?? [];
        _outline = outline;
        ApplyColors();
    }

    void LayoutKeys()
    {
        var width = ActualWidth;
        var height = ActualHeight;
        if (width <= 1 || height <= 1) return;
        var scale = Math.Min(width / KeyLayout.MaxX, height / KeyLayout.MaxY);
        var originX = (width - KeyLayout.MaxX * scale) / 2;
        var originY = (height - KeyLayout.MaxY * scale) / 2;
        var gap = Math.Max(1, scale * 0.1);
        var radius = Math.Max(1, Math.Min(2.5, scale * 0.15));
        for (var i = 0; i < KeyLayout.Keys.Length; i++)
        {
            var key = KeyLayout.Keys[i];
            var cap = _caps[i];
            cap.Width = Math.Max(1, key.W * scale - gap);
            cap.Height = Math.Max(1, key.H * scale - gap);
            cap.RadiusX = radius;
            cap.RadiusY = radius;
            SetLeft(cap, originX + key.X * scale + gap / 2);
            SetTop(cap, originY + key.Y * scale + gap / 2);
        }
        ApplyColors();
    }

    void ApplyColors()
    {
        for (var i = 0; i < _caps.Length; i++)
        {
            var cap = _caps[i];
            if (_outline)
            {
                cap.Fill = _idleFill;
                cap.Stroke = _idleStroke;
                continue;
            }
            cap.Stroke = null;
            var offset = i * 3;
            if (offset + 2 >= _rgb.Length)
            {
                cap.Fill = _baseFill;
                continue;
            }
            var r = _rgb[offset];
            var g = _rgb[offset + 1];
            var b = _rgb[offset + 2];
            if (r == 0 && g == 0 && b == 0)
            {
                cap.Fill = _baseFill;
                continue;
            }
            // Approximate Mac plusLighter: sit the engine RGB on the dark cap.
            cap.Fill = new SolidColorBrush(Color.FromArgb(
                255,
                SaturateAdd(KeyBase.R, r),
                SaturateAdd(KeyBase.G, g),
                SaturateAdd(KeyBase.B, b)));
        }
    }

    static byte SaturateAdd(byte a, byte b) => (byte)Math.Min(255, a + b);
}
