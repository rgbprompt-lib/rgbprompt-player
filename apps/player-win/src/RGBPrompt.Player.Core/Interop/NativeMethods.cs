using System.Runtime.InteropServices;

namespace RGBPrompt.Player.Core.Interop;

/// <summary>C ABI surface from apps/player-core/include/rgbprompt_player.h (ABI v2).</summary>
public static partial class NativeMethods
{
    public const string DllName = "rgbprompt_player";
    public const uint AbiVersion = 2;
    public const int Ok = 0;

    [StructLayout(LayoutKind.Sequential)]
    public struct RgbpConfig
    {
        public IntPtr DataDir;
        public IntPtr ApiBase;
        public IntPtr Platform;
        public IntPtr Language;
        public IntPtr AppVersion;
        public IntPtr OsVersion;
        public IntPtr OpenRgbAddr;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RgbpStateEvent
    {
        public int State;
        public int Error;
        public IntPtr EffectName;
        public IntPtr KeyboardName;
        public int KeyboardSupport;
        public uint Fps;
        public int DriverProgress;
        public int DriverError;
        public IntPtr ConflictName;
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    public delegate void RgbpStateCallback(IntPtr ev, IntPtr user);

    [LibraryImport(DllName, EntryPoint = "rgbp_abi_version")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial uint rgbp_abi_version();

    [LibraryImport(DllName, EntryPoint = "rgbp_create")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial IntPtr rgbp_create(in RgbpConfig config);

    [LibraryImport(DllName, EntryPoint = "rgbp_destroy")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial void rgbp_destroy(IntPtr handle);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_state_callback")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_state_callback(IntPtr handle, RgbpStateCallback callback, IntPtr user);

    [LibraryImport(DllName, EntryPoint = "rgbp_open_url", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_open_url(IntPtr handle, string url);

    [LibraryImport(DllName, EntryPoint = "rgbp_open_lep_file", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_open_lep_file(IntPtr handle, string path);

    [LibraryImport(DllName, EntryPoint = "rgbp_stop")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_stop(IntPtr handle);

    [LibraryImport(DllName, EntryPoint = "rgbp_install_driver")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_install_driver(IntPtr handle);

    [LibraryImport(DllName, EntryPoint = "rgbp_retry")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_retry(IntPtr handle);

    [LibraryImport(DllName, EntryPoint = "rgbp_restart_backend")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_restart_backend(IntPtr handle);

    [LibraryImport(DllName, EntryPoint = "rgbp_notify_devices_changed")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_notify_devices_changed(IntPtr handle);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_preferred_keyboard", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_preferred_keyboard(IntPtr handle, string name);

    [LibraryImport(DllName, EntryPoint = "rgbp_preview_frame")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial long rgbp_preview_frame(IntPtr handle, Span<byte> output);

    [LibraryImport(DllName, EntryPoint = "rgbp_push_audio_pcm")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_push_audio_pcm(IntPtr handle, ReadOnlySpan<float> interleaved, nuint frames, ushort channels, double sampleRate);

    [LibraryImport(DllName, EntryPoint = "rgbp_push_key", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_push_key(IntPtr handle, string keyName, [MarshalAs(UnmanagedType.I1)] bool down);

    [LibraryImport(DllName, EntryPoint = "rgbp_input_wanted")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial uint rgbp_input_wanted(IntPtr handle);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_brightness")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_brightness(IntPtr handle, byte brightness);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_language", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_language(IntPtr handle, string language);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_audio_enabled")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_audio_enabled(IntPtr handle, [MarshalAs(UnmanagedType.I1)] bool enabled);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_key_reactive_enabled")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_key_reactive_enabled(IntPtr handle, [MarshalAs(UnmanagedType.I1)] bool enabled);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_protocol_registered")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_protocol_registered(IntPtr handle, [MarshalAs(UnmanagedType.I1)] bool registered);

    [LibraryImport(DllName, EntryPoint = "rgbp_diagnostics_json")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_diagnostics_json(IntPtr handle, Span<byte> output, nuint cap);

    [LibraryImport(DllName, EntryPoint = "rgbp_driver_info_json")]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_driver_info_json(IntPtr handle, Span<byte> output, nuint cap);

    [LibraryImport(DllName, EntryPoint = "rgbp_set_driver_manifest_json", StringMarshalling = StringMarshalling.Utf8)]
    [UnmanagedCallConv(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    public static partial int rgbp_set_driver_manifest_json(IntPtr handle, string json);
}
