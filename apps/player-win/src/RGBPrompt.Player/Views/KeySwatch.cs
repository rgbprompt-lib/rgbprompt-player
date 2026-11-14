using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace RGBPrompt.Player.Views;

/// <summary>
/// Mac <c>KeySwatch</c>: the whole keyboard frame stretched to the swatch and
/// blurred, so it reads as the effect's palette rather than a mosaic. Drawn as
/// a small bitmap (average-colour background, one block per key, box blur)
/// that the brush scales up smoothly; radius 4 with a faint 8 % stroke.
/// </summary>
static class KeySwatch
{
    const int W = 45; // 2 px per key unit (22.5 × 6)
    const int H = 12;

    public static Border Make(IReadOnlyList<byte> rgb, double width, double height)
    {
        var border = new Border
        {
            Width = width,
            Height = height,
            CornerRadius = new CornerRadius(4),
            BorderBrush = PlayerTheme.SwatchStrokeBrush,
            BorderThickness = new Thickness(1),
            VerticalAlignment = VerticalAlignment.Center,
        };
        Paint(border, rgb);
        return border;
    }

    public static void Paint(Border border, IReadOnlyList<byte> rgb)
    {
        var keys = rgb.Count / 3;
        if (keys == 0)
        {
            border.Background = PlayerTheme.InsetBrush;
            return;
        }
        var pixels = new float[W * H * 3];
        // Gaps between key blocks take the average colour, not black.
        float ar = 0, ag = 0, ab = 0;
        for (var i = 0; i < keys; i++) { ar += rgb[i * 3]; ag += rgb[i * 3 + 1]; ab += rgb[i * 3 + 2]; }
        ar /= keys; ag /= keys; ab /= keys;
        for (var p = 0; p < W * H; p++) { pixels[p * 3] = ar; pixels[p * 3 + 1] = ag; pixels[p * 3 + 2] = ab; }
        var sx = W / KeyLayout.MaxX;
        var sy = H / KeyLayout.MaxY;
        for (var i = 0; i < Math.Min(keys, KeyLayout.Keys.Length); i++)
        {
            var key = KeyLayout.Keys[i];
            var x0 = (int)Math.Floor(key.X * sx);
            var y0 = (int)Math.Floor(key.Y * sy);
            var x1 = Math.Min(W, (int)Math.Ceiling((key.X + key.W) * sx));
            var y1 = Math.Min(H, (int)Math.Ceiling((key.Y + key.H) * sy));
            for (var y = y0; y < y1; y++)
            for (var x = x0; x < x1; x++)
            {
                var p = (y * W + x) * 3;
                pixels[p] = rgb[i * 3];
                pixels[p + 1] = rgb[i * 3 + 1];
                pixels[p + 2] = rgb[i * 3 + 2];
            }
        }
        for (var pass = 0; pass < 4; pass++) pixels = Blur(pixels);
        var bitmap = new WriteableBitmap(W, H);
        var bytes = new byte[W * H * 4];
        for (var p = 0; p < W * H; p++)
        {
            bytes[p * 4] = (byte)Math.Clamp(pixels[p * 3 + 2], 0, 255);
            bytes[p * 4 + 1] = (byte)Math.Clamp(pixels[p * 3 + 1], 0, 255);
            bytes[p * 4 + 2] = (byte)Math.Clamp(pixels[p * 3], 0, 255);
            bytes[p * 4 + 3] = 255;
        }
        using (var stream = bitmap.PixelBuffer.AsStream())
            stream.Write(bytes, 0, bytes.Length);
        bitmap.Invalidate();
        border.Background = new ImageBrush { ImageSource = bitmap, Stretch = Stretch.Fill };
    }

    /// <summary>3×3 box blur with edge clamping (four passes ≈ the Mac 2.5 pt blur at swatch size).</summary>
    static float[] Blur(float[] src)
    {
        var dst = new float[src.Length];
        for (var y = 0; y < H; y++)
        for (var x = 0; x < W; x++)
        {
            float r = 0, g = 0, b = 0;
            for (var dy = -1; dy <= 1; dy++)
            for (var dx = -1; dx <= 1; dx++)
            {
                var p = (Math.Clamp(y + dy, 0, H - 1) * W + Math.Clamp(x + dx, 0, W - 1)) * 3;
                r += src[p]; g += src[p + 1]; b += src[p + 2];
            }
            var o = (y * W + x) * 3;
            dst[o] = r / 9; dst[o + 1] = g / 9; dst[o + 2] = b / 9;
        }
        return dst;
    }
}
