using System.Runtime.InteropServices;

namespace RGBPrompt.Player.Input;

/// <summary>WASAPI / MMDevice COM surface used by <see cref="WasapiAudioCapture"/>.</summary>
internal static class WasapiNative
{
    public const uint ClsctxAll = 0x17;
    public const uint CoInitMultithreaded = 0;
    public const uint ShareModeShared = 0;
    public const uint StreamFlagsLoopback = 0x00020000;
    public const uint StreamFlagsEventCallback = 0x00040000;
    public const uint BufferFlagSilent = 0x1;
    public const int DataFlowRender = 0;
    public const int RoleConsole = 0;
    public const ushort WaveFormatPcm = 1;
    public const ushort WaveFormatIeeeFloat = 3;
    public const ushort WaveFormatTagExtensible = 0xFFFE;
    public const int MaxChannels = 8;

    public static readonly Guid ClsidMmDeviceEnumerator = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    public static readonly Guid IidIAudioClient = new("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    public static readonly Guid IidIAudioCaptureClient = new("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    public static readonly Guid KsdataformatSubtypeIeeeFloat = new("00000003-0000-0010-8000-00aa00389b71");
    public static readonly Guid KsdataformatSubtypePcm = new("00000001-0000-0010-8000-00aa00389b71");

    public const uint WaitObject0 = 0;
    public const uint WaitTimeout = 0x102;

    [DllImport("ole32.dll")]
    public static extern int CoInitializeEx(IntPtr reserved, uint coInit);

    [DllImport("ole32.dll")]
    public static extern void CoUninitialize();

    [DllImport("ole32.dll")]
    public static extern int CoCreateInstance(
        [In] ref Guid clsid,
        IntPtr outer,
        uint clsContext,
        [In] ref Guid iid,
        [MarshalAs(UnmanagedType.IUnknown)] out object obj);

    [DllImport("ole32.dll")]
    public static extern void CoTaskMemFree(IntPtr pointer);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct WaveFormatEx
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSec;
        public uint AvgBytesPerSec;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort Size;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct WaveFormatExtensible
    {
        public WaveFormatEx Format;
        public ushort ValidBitsPerSample;
        public uint ChannelMask;
        public Guid SubFormat;
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(); // unused
        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        void GetDevice(); // unused
        [PreserveSig]
        int RegisterEndpointNotificationCallback([MarshalAs(UnmanagedType.Interface)] IMMNotificationClient client);
        [PreserveSig]
        int UnregisterEndpointNotificationCallback([MarshalAs(UnmanagedType.Interface)] IMMNotificationClient client);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig]
        int Activate(
            [In] ref Guid iid,
            uint clsCtx,
            IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object interface_);
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig]
        int Initialize(
            uint shareMode,
            uint streamFlags,
            long bufferDuration,
            long periodicity,
            IntPtr format,
            IntPtr session);

        [PreserveSig]
        int GetBufferSize(out uint bufferSize);

        [PreserveSig]
        int GetStreamLatency(out long latency);

        [PreserveSig]
        int GetCurrentPadding(out uint padding);

        [PreserveSig]
        int IsFormatSupported(uint shareMode, IntPtr format, out IntPtr closestMatch);

        [PreserveSig]
        int GetMixFormat(out IntPtr format);

        [PreserveSig]
        int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

        [PreserveSig]
        int Start();

        [PreserveSig]
        int Stop();

        [PreserveSig]
        int Reset();

        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);

        [PreserveSig]
        int GetService(
            [In] ref Guid iid,
            [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(
            out IntPtr data,
            out uint numFramesAvailable,
            out uint flags,
            out ulong devicePosition,
            out ulong qpcPosition);

        [PreserveSig]
        int ReleaseBuffer(uint numFramesRead);

        [PreserveSig]
        int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [ComImport]
    [Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMNotificationClient
    {
        [PreserveSig]
        int OnDeviceStateChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, uint newState);

        [PreserveSig]
        int OnDeviceAdded([MarshalAs(UnmanagedType.LPWStr)] string deviceId);

        [PreserveSig]
        int OnDeviceRemoved([MarshalAs(UnmanagedType.LPWStr)] string deviceId);

        [PreserveSig]
        int OnDefaultDeviceChanged(int flow, int role, [MarshalAs(UnmanagedType.LPWStr)] string defaultDeviceId);

        [PreserveSig]
        int OnPropertyValueChanged([MarshalAs(UnmanagedType.LPWStr)] string deviceId, PropertyKey key);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey
    {
        public Guid Fmtid;
        public int Pid;
    }
}
