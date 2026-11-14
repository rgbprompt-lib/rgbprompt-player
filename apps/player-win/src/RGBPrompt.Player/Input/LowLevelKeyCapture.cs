using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using RGBPrompt.Player.Core.Input;

namespace RGBPrompt.Player.Input;

/// <summary>
/// Session-wide <c>WH_KEYBOARD_LL</c> hook. The hook procedure only enqueues;
/// names are mapped through <see cref="KeyNameMap"/> and never logged.
/// </summary>
public sealed class LowLevelKeyCapture : IKeyCapture
{
    const int WhKeyboardLl = 13;
    const int WmQuit = 0x0012;
    const uint LlkhfExtended = 0x01;
    const uint LlkhfInjected = 0x10;
    const uint LlkhfUp = 0x80;

    readonly ConcurrentQueue<(string Name, bool Down)> _queue = new();
    readonly HashSet<(int Vk, bool Extended)> _down = new();
    readonly object _gate = new();
    readonly HookProc _proc;

    Thread? _thread;
    int _threadId;
    IntPtr _hook;
    int _running;
    int _drainScheduled;

    public LowLevelKeyCapture()
    {
        // Keep the delegate alive for the lifetime of the hook.
        _proc = HookCallback;
    }

    public bool IsRunning => Volatile.Read(ref _running) == 1;

    public event Action<string, bool>? KeyEvent;

    public void Start()
    {
        lock (_gate)
        {
            if (IsRunning) return;
            var started = new ManualResetEventSlim(false);
            var ok = false;
            _thread = new Thread(() => HookThread(started, ref ok))
            {
                IsBackground = true,
                Name = "RGBPrompt.KeyHook",
            };
            _thread.Start();
            if (!started.Wait(TimeSpan.FromSeconds(2)) || !ok)
            {
                Stop();
                return;
            }
        }
    }

    public void Stop()
    {
        Thread? thread;
        int threadId;
        lock (_gate)
        {
            thread = _thread;
            threadId = _threadId;
            _thread = null;
            _threadId = 0;
        }
        if (threadId != 0)
            PostThreadMessage(threadId, WmQuit, IntPtr.Zero, IntPtr.Zero);
        if (thread != null && thread.IsAlive)
            thread.Join(TimeSpan.FromSeconds(2));
        _down.Clear();
        while (_queue.TryDequeue(out _)) { }
        Volatile.Write(ref _running, 0);
    }

    public void Dispose() => Stop();

    void HookThread(ManualResetEventSlim started, ref bool ok)
    {
        _threadId = GetCurrentThreadId();
        _hook = SetWindowsHookExW(WhKeyboardLl, _proc, GetModuleHandleW(null), 0);
        if (_hook == IntPtr.Zero)
        {
            System.Diagnostics.Debug.WriteLine("key_capture start failed");
            started.Set();
            return;
        }

        ok = true;
        Volatile.Write(ref _running, 1);
        started.Set();
        System.Diagnostics.Debug.WriteLine("key_capture start");

        while (GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }

        if (_hook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
        }
        Volatile.Write(ref _running, 0);
        System.Diagnostics.Debug.WriteLine("key_capture stop");
    }

    IntPtr HookCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0 && lParam != IntPtr.Zero)
        {
            var info = Marshal.PtrToStructure<KbdLlHookStruct>(lParam);
            Enqueue(info);
        }
        return CallNextHookEx(_hook, code, wParam, lParam);
    }

    void Enqueue(KbdLlHookStruct info)
    {
        // Do not process injected events; never log the key identity.
        if ((info.Flags & LlkhfInjected) != 0)
            return;

        var extended = (info.Flags & LlkhfExtended) != 0;
        var down = (info.Flags & LlkhfUp) == 0;
        var vk = (int)info.VkCode;
        var name = KeyNameMap.Name(vk, extended);
        if (name is null)
            return;

        var key = (vk, extended);
        if (down)
        {
            if (!_down.Add(key))
                return; // auto-repeat
        }
        else
        {
            _down.Remove(key);
        }

        _queue.Enqueue((name, down));
        if (Interlocked.Exchange(ref _drainScheduled, 1) == 0)
            ThreadPool.UnsafeQueueUserWorkItem(static state => ((LowLevelKeyCapture)state!).Drain(), this);
    }

    void Drain()
    {
        try
        {
            while (_queue.TryDequeue(out var ev))
                KeyEvent?.Invoke(ev.Name, ev.Down);
        }
        finally
        {
            Interlocked.Exchange(ref _drainScheduled, 0);
            if (!_queue.IsEmpty && Interlocked.Exchange(ref _drainScheduled, 1) == 0)
                ThreadPool.UnsafeQueueUserWorkItem(static state => ((LowLevelKeyCapture)state!).Drain(), this);
        }
    }

    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct KbdLlHookStruct
    {
        public uint VkCode;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Msg
    {
        public IntPtr Hwnd;
        public uint Message;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookExW(int hookId, HookProc proc, IntPtr module, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern int GetMessageW(out Msg msg, IntPtr hwnd, uint min, uint max);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref Msg msg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessageW(ref Msg msg);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool PostThreadMessage(int threadId, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    static extern int GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandleW(string? module);
}
