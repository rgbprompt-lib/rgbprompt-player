using System.Runtime.InteropServices;
using RGBPrompt.Player.Core.Input;

namespace RGBPrompt.Player.Services;

/// <summary>
/// RegisterDeviceNotification for <c>GUID_DEVINTERFACE_HID</c>. Coalesces
/// arrival/removal (and devnode changes) for 300 ms, then invokes the
/// callback on the constructor SynchronizationContext so the shell can call
/// <c>rgbp_notify_devices_changed</c> (forced OpenRGB rescan).
/// </summary>
public sealed class DeviceNotificationService : IDisposable
{
    const int WmDeviceChange = 0x0219;
    const int DbtDeviceArrival = 0x8000;
    const int DbtDeviceRemoveComplete = 0x8004;
    const int DbtDevnodesChanged = 0x0007;
    const int DbtDevtypDeviceInterface = 0x00000005;
    const int DeviceNotifyWindowHandle = 0;

    static readonly Guid GuidDevinterfaceHid = new("4D1E55B2-F16F-11CF-88CB-001111000030");

    readonly Action _onChanged;
    readonly SynchronizationContext? _sync;
    readonly DeviceChangeCoalescer _coalescer;
    MessageOnlyWindow? _window;
    IntPtr _notification;
    bool _started;

    public DeviceNotificationService(Action onChanged, SynchronizationContext? sync = null)
    {
        _onChanged = onChanged;
        _sync = sync ?? SynchronizationContext.Current;
        _coalescer = new DeviceChangeCoalescer();
        _coalescer.OnFlush = (_, _) => Dispatch();
    }

    public void Start()
    {
        if (_started) return;
        _window = new MessageOnlyWindow(WndProc);
        var filter = new DevBroadcastDeviceInterface
        {
            Size = Marshal.SizeOf<DevBroadcastDeviceInterface>(),
            DeviceType = DbtDevtypDeviceInterface,
            ClassGuid = GuidDevinterfaceHid,
        };
        var filterPtr = Marshal.AllocHGlobal(filter.Size);
        try
        {
            Marshal.StructureToPtr(filter, filterPtr, false);
            _notification = RegisterDeviceNotificationW(_window.Handle, filterPtr, DeviceNotifyWindowHandle);
        }
        finally
        {
            Marshal.FreeHGlobal(filterPtr);
        }
        _started = true;
    }

    public void Dispose()
    {
        if (_notification != IntPtr.Zero)
        {
            UnregisterDeviceNotification(_notification);
            _notification = IntPtr.Zero;
        }
        _window?.Dispose();
        _window = null;
        _coalescer.Dispose();
        _started = false;
    }

    IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != WmDeviceChange)
            return IntPtr.Zero;

        var eventType = wParam.ToInt32();
        switch (eventType)
        {
            case DbtDeviceArrival:
                _coalescer.Record(added: 1);
                handled = true;
                break;
            case DbtDeviceRemoveComplete:
                _coalescer.Record(removed: 1);
                handled = true;
                break;
            case DbtDevnodesChanged:
                _coalescer.Record(added: 0, removed: 0);
                handled = true;
                break;
        }
        return IntPtr.Zero;
    }

    void Dispatch()
    {
        void Invoke()
        {
            try { _onChanged(); }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"device_change callback failed: {ex.GetType().Name}");
            }
        }

        if (_sync != null)
            _sync.Post(_ => Invoke(), null);
        else
            Invoke();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DevBroadcastDeviceInterface
    {
        public int Size;
        public int DeviceType;
        public int Reserved;
        public Guid ClassGuid;
        public char Name; // first character of the variable-length name
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr RegisterDeviceNotificationW(IntPtr recipient, IntPtr filter, int flags);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnregisterDeviceNotification(IntPtr handle);
}

/// <summary>Message-only window that delivers <c>WM_DEVICECHANGE</c>.</summary>
sealed class MessageOnlyWindow : IDisposable
{
    const int WsExNoActivate = 0x08000000;
    const int HwndMessage = -3;
    const int WmNcDestroy = 0x0082;

    static int _counter;
    readonly WndProc _proc;
    readonly string _className;
    readonly WndProcHandler _handler;
    bool _classRegistered;

    public IntPtr Handle { get; private set; }

    public MessageOnlyWindow(WndProcHandler handler)
    {
        _handler = handler;
        _proc = NativeWndProc;
        _className = "RGBPrompt.DeviceNotify." + Interlocked.Increment(ref _counter);

        var wndClass = new WndClassEx
        {
            Size = (uint)Marshal.SizeOf<WndClassEx>(),
            WindowProc = _proc,
            Instance = GetModuleHandleW(null),
            ClassName = _className,
        };
        var atom = RegisterClassExW(ref wndClass);
        if (atom == 0)
            throw new InvalidOperationException($"RegisterClassEx failed ({Marshal.GetLastWin32Error()}).");
        _classRegistered = true;

        Handle = CreateWindowExW(
            WsExNoActivate,
            _className,
            string.Empty,
            0,
            0, 0, 0, 0,
            new IntPtr(HwndMessage),
            IntPtr.Zero,
            wndClass.Instance,
            IntPtr.Zero);
        if (Handle == IntPtr.Zero)
            throw new InvalidOperationException($"CreateWindowEx failed ({Marshal.GetLastWin32Error()}).");
    }

    IntPtr NativeWndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        var handled = false;
        var result = _handler(hwnd, msg, wParam, lParam, ref handled);
        if (handled)
            return result;
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    public void Dispose()
    {
        if (Handle != IntPtr.Zero)
        {
            DestroyWindow(Handle);
            Handle = IntPtr.Zero;
        }
        if (_classRegistered)
        {
            UnregisterClassW(_className, GetModuleHandleW(null));
            _classRegistered = false;
        }
        GC.KeepAlive(_proc);
        _ = WmNcDestroy;
    }

    public delegate IntPtr WndProcHandler(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, ref bool handled);

    delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WndClassEx
    {
        public uint Size;
        public uint Style;
        public WndProc WindowProc;
        public int ClsExtra;
        public int WndExtra;
        public IntPtr Instance;
        public IntPtr Icon;
        public IntPtr Cursor;
        public IntPtr Background;
        public string? MenuName;
        public string ClassName;
        public IntPtr SmallIcon;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern ushort RegisterClassExW(ref WndClassEx windowClass);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool UnregisterClassW(string className, IntPtr instance);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(
        int exStyle,
        string className,
        string windowName,
        int style,
        int x,
        int y,
        int width,
        int height,
        IntPtr parent,
        IntPtr menu,
        IntPtr instance,
        IntPtr param);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool DestroyWindow(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandleW(string? module);
}
