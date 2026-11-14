using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;

namespace RGBPrompt.Player.Views;

/// <summary>
/// AppWindow.Resize takes physical pixels; our layouts are designed in DIPs.
/// Scale by the window's DPI so the panel is not tiny on 150%+ displays.
/// </summary>
static partial class WindowSizing
{
    [LibraryImport("user32.dll")]
    private static partial uint GetDpiForWindow(IntPtr hwnd);

    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr hwnd, out Rect rect);

    public static double Scale(IntPtr hwnd)
    {
        var dpi = GetDpiForWindow(hwnd);
        return dpi == 0 ? 1.0 : dpi / 96.0;
    }

    /// <summary>
    /// Makes the Win32 client area (all of our XAML once the caption is gone)
    /// exactly <paramref name="widthDip"/>×<paramref name="heightDip"/>.
    /// AppWindow.Resize counts the invisible resize borders, and
    /// AppWindow.ResizeClient still reserves a caption band, so the frame
    /// overhead is read from GetWindowRect − GetClientRect instead.
    /// </summary>
    public static void ResizeClientDip(AppWindow appWindow, IntPtr hwnd, double widthDip, double heightDip)
    {
        var scale = Scale(hwnd);
        var width = (int)Math.Ceiling(widthDip * scale);
        var height = (int)Math.Ceiling(heightDip * scale);
        var extraW = 0;
        var extraH = 0;
        if (GetWindowRect(hwnd, out var outer) && GetClientRect(hwnd, out var client))
        {
            extraW = (outer.Right - outer.Left) - (client.Right - client.Left);
            extraH = (outer.Bottom - outer.Top) - (client.Bottom - client.Top);
        }
        appWindow.Resize(new Windows.Graphics.SizeInt32(width + extraW, height + extraH));
    }
}
