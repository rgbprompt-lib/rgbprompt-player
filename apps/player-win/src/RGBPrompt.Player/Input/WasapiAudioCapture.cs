using System.Runtime.InteropServices;
using RGBPrompt.Player.Core.Input;

namespace RGBPrompt.Player.Input;

/// <summary>
/// WASAPI shared-mode loopback of the default render device. Converts to
/// interleaved f32 and resamples to 48 kHz so the v15 analyser sees the same
/// contract the Mac Player feeds the core (hop 512 @ 48 kHz).
/// </summary>
public sealed class WasapiAudioCapture : IAudioCapture
{
    readonly object _gate = new();
    readonly PcmResampler _resampler = new();
    Thread? _thread;
    CancellationTokenSource? _cts;
    ManualResetEventSlim? _started;
    Exception? _startError;
    int _running;

    public bool IsRunning => Volatile.Read(ref _running) == 1;

    public event Action<float[], int, ushort, double>? SamplesAvailable;

    public void Start()
    {
        lock (_gate)
        {
            if (IsRunning) return;
            _startError = null;
            _cts = new CancellationTokenSource();
            _started = new ManualResetEventSlim(false);
            var token = _cts.Token;
            _thread = new Thread(() => CaptureThread(token))
            {
                IsBackground = true,
                Name = "RGBPrompt.WasapiLoopback",
            };
            _thread.Start();
            // Wait briefly so IsRunning reflects a successful first session
            // when the default render device is already present. A missing
            // device is retried by the capture thread; Start itself does not throw.
            _started.Wait(TimeSpan.FromSeconds(2));
        }
    }

    public void Stop()
    {
        Thread? thread;
        CancellationTokenSource? cts;
        lock (_gate)
        {
            thread = _thread;
            cts = _cts;
            _thread = null;
            _cts = null;
        }
        try { cts?.Cancel(); } catch (ObjectDisposedException) { /* already stopping */ }
        if (thread != null && thread.IsAlive)
            thread.Join(TimeSpan.FromSeconds(2));
        cts?.Dispose();
        _started?.Dispose();
        _started = null;
        _resampler.Reset();
        Volatile.Write(ref _running, 0);
    }

    public void Rebuild()
    {
        lock (_gate)
        {
            if (!IsRunning) return;
        }
        // The capture thread re-inits when it sees this flag.
        Volatile.Write(ref _rebuild, 1);
    }

    public void Dispose() => Stop();

    int _rebuild;

    void CaptureThread(CancellationToken token)
    {
        var hr = WasapiNative.CoInitializeEx(IntPtr.Zero, WasapiNative.CoInitMultithreaded);
        var comInit = hr >= 0;
        try
        {
            while (!token.IsCancellationRequested)
            {
                Volatile.Write(ref _rebuild, 0);
                try
                {
                    RunSession(token);
                    _startError = null;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _startError = ex;
                    Volatile.Write(ref _running, 0);
                    _started?.Set();
                    // Retry after a short pause (device may be mid-switch).
                    if (token.WaitHandle.WaitOne(500))
                        break;
                    continue;
                }

                if (token.IsCancellationRequested)
                    break;
                if (Volatile.Read(ref _rebuild) == 0)
                {
                    if (token.WaitHandle.WaitOne(250))
                        break;
                }
            }
        }
        finally
        {
            Volatile.Write(ref _running, 0);
            if (comInit)
                WasapiNative.CoUninitialize();
        }
    }

    void RunSession(CancellationToken token)
    {
        var clsid = WasapiNative.ClsidMmDeviceEnumerator;
        var iidEnum = typeof(WasapiNative.IMMDeviceEnumerator).GUID;
        var hr = WasapiNative.CoCreateInstance(ref clsid, IntPtr.Zero, WasapiNative.ClsctxAll, ref iidEnum, out var rawEnum);
        if (hr < 0 || rawEnum is not WasapiNative.IMMDeviceEnumerator enumerator)
            throw new InvalidOperationException($"WASAPI enumerator failed (hr=0x{hr:X8}).");

        DeviceChangeListener? listener = null;
        try
        {
            listener = new DeviceChangeListener(() => Rebuild());
            _ = enumerator.RegisterEndpointNotificationCallback(listener);

            hr = enumerator.GetDefaultAudioEndpoint(
                WasapiNative.DataFlowRender,
                WasapiNative.RoleConsole,
                out var device);
            if (hr < 0 || device is null)
                throw new InvalidOperationException($"No default render device (hr=0x{hr:X8}).");

            var iidClient = WasapiNative.IidIAudioClient;
            hr = device.Activate(ref iidClient, WasapiNative.ClsctxAll, IntPtr.Zero, out var rawClient);
            if (hr < 0 || rawClient is not WasapiNative.IAudioClient client)
                throw new InvalidOperationException($"IAudioClient activate failed (hr=0x{hr:X8}).");

            hr = client.GetMixFormat(out var formatPtr);
            if (hr < 0 || formatPtr == IntPtr.Zero)
                throw new InvalidOperationException($"GetMixFormat failed (hr=0x{hr:X8}).");

            IntPtr eventHandle = IntPtr.Zero;
            try
            {
                var format = ParseFormat(formatPtr);
                // 100 ms buffer; loopback shared mode ignores periodicity when event-driven.
                const long bufferDuration = 1_000_000; // 100 ms in 100-ns units
                hr = client.Initialize(
                    WasapiNative.ShareModeShared,
                    WasapiNative.StreamFlagsLoopback | WasapiNative.StreamFlagsEventCallback,
                    bufferDuration,
                    0,
                    formatPtr,
                    IntPtr.Zero);
                if (hr < 0)
                    throw new InvalidOperationException($"IAudioClient.Initialize failed (hr=0x{hr:X8}).");

                eventHandle = WasapiNative.CreateEventW(IntPtr.Zero, false, false, IntPtr.Zero);
                if (eventHandle == IntPtr.Zero)
                    throw new InvalidOperationException("CreateEvent failed for WASAPI.");
                hr = client.SetEventHandle(eventHandle);
                if (hr < 0)
                    throw new InvalidOperationException($"SetEventHandle failed (hr=0x{hr:X8}).");

                var iidCapture = WasapiNative.IidIAudioCaptureClient;
                hr = client.GetService(ref iidCapture, out var rawCapture);
                if (hr < 0 || rawCapture is not WasapiNative.IAudioCaptureClient capture)
                    throw new InvalidOperationException($"IAudioCaptureClient failed (hr=0x{hr:X8}).");

                hr = client.Start();
                if (hr < 0)
                    throw new InvalidOperationException($"IAudioClient.Start failed (hr=0x{hr:X8}).");

                Volatile.Write(ref _running, 1);
                _started?.Set();
                System.Diagnostics.Debug.WriteLine("audio_capture start");

                try
                {
                    Pump(client, capture, eventHandle, format, token);
                }
                finally
                {
                    _ = client.Stop();
                    System.Diagnostics.Debug.WriteLine("audio_capture stop");
                }
            }
            finally
            {
                if (formatPtr != IntPtr.Zero)
                    WasapiNative.CoTaskMemFree(formatPtr);
                if (eventHandle != IntPtr.Zero)
                    WasapiNative.CloseHandle(eventHandle);
            }
        }
        finally
        {
            if (listener != null)
                _ = enumerator.UnregisterEndpointNotificationCallback(listener);
        }
    }

    void Pump(
        WasapiNative.IAudioClient client,
        WasapiNative.IAudioCaptureClient capture,
        IntPtr eventHandle,
        MixFormat format,
        CancellationToken token)
    {
        // client is kept so the COM object isn't released mid-pump.
        _ = client;
        _mixRate = format.SampleRate;
        var convertScratch = Array.Empty<float>();

        while (!token.IsCancellationRequested && Volatile.Read(ref _rebuild) == 0)
        {
            var wait = WasapiNative.WaitForSingleObject(eventHandle, 100);
            if (wait == WasapiNative.WaitTimeout)
                continue;
            if (token.IsCancellationRequested || Volatile.Read(ref _rebuild) != 0)
                break;

            while (true)
            {
                var hr = capture.GetNextPacketSize(out var packet);
                if (hr < 0) throw new InvalidOperationException($"GetNextPacketSize hr=0x{hr:X8}");
                if (packet == 0) break;

                hr = capture.GetBuffer(out var data, out var frames, out var flags, out _, out _);
                if (hr < 0) throw new InvalidOperationException($"GetBuffer hr=0x{hr:X8}");
                try
                {
                    if (frames == 0) continue;
                    var needed = (int)frames * format.Channels;
                    if (convertScratch.Length < needed)
                        convertScratch = new float[needed];

                    if ((flags & WasapiNative.BufferFlagSilent) != 0 || data == IntPtr.Zero)
                    {
                        Array.Clear(convertScratch, 0, needed);
                    }
                    else
                    {
                        ConvertToFloat(data, (int)frames, format, convertScratch);
                    }

                    PushConverted(convertScratch, (int)frames, format.Channels);
                }
                finally
                {
                    _ = capture.ReleaseBuffer(frames);
                }
            }
        }
    }

    void PushConverted(float[] interleaved, int frames, int channels)
    {
        var output = _resampler.Resample(interleaved, frames, channels, _mixRate, out var outFrames);
        if (outFrames <= 0) return;
        var outChannels = (ushort)Math.Clamp(channels, 1, WasapiNative.MaxChannels);
        SamplesAvailable?.Invoke(output, outFrames, outChannels, PcmResampler.TargetRate);
    }

    double _mixRate = PcmResampler.TargetRate;

    static MixFormat ParseFormat(IntPtr formatPtr)
    {
        var raw = Marshal.PtrToStructure<WasapiNative.WaveFormatEx>(formatPtr)!;
        var tag = raw.FormatTag;
        var channels = Math.Clamp((int)raw.Channels, 1, WasapiNative.MaxChannels);
        var bits = raw.BitsPerSample;
        var validBits = bits;
        var subFormat = Guid.Empty;
        if (tag == WasapiNative.WaveFormatTagExtensible && raw.Size >= 22)
        {
            var ext = Marshal.PtrToStructure<WasapiNative.WaveFormatExtensible>(formatPtr);
            validBits = ext.ValidBitsPerSample != 0 ? ext.ValidBitsPerSample : bits;
            subFormat = ext.SubFormat;
        }

        var isFloat = tag == WasapiNative.WaveFormatIeeeFloat
            || subFormat == WasapiNative.KsdataformatSubtypeIeeeFloat;
        var isPcm = tag == WasapiNative.WaveFormatPcm
            || subFormat == WasapiNative.KsdataformatSubtypePcm;

        Kind kind;
        if (isFloat && bits == 32) kind = Kind.Float32;
        else if (isFloat && bits == 64) kind = Kind.Float64;
        else if (isPcm && (validBits == 16 || bits == 16)) kind = Kind.Int16;
        else if (isPcm && (validBits == 24 && bits == 32)) kind = Kind.Int24In32;
        else if (isPcm && (validBits == 24 && bits == 24)) kind = Kind.Int24Packed;
        else if (isPcm && bits == 32) kind = Kind.Int32;
        else
            throw new InvalidOperationException(
                $"Unsupported mix format tag=0x{tag:X} bits={bits} valid={validBits}.");

        return new MixFormat(
            Channels: channels,
            SampleRate: raw.SamplesPerSec,
            BlockAlign: raw.BlockAlign,
            Kind: kind,
            DeclaredChannels: raw.Channels);
    }

    void ConvertToFloat(IntPtr data, int frames, MixFormat format, float[] dest)
    {
        _mixRate = format.SampleRate;
        var channels = format.Channels;
        var sourceChannels = format.DeclaredChannels;
        var block = format.BlockAlign;

        unsafe
        {
            var src = (byte*)data.ToPointer();
            for (var frame = 0; frame < frames; frame++)
            {
                var framePtr = src + frame * block;
                for (var ch = 0; ch < channels; ch++)
                {
                    dest[frame * channels + ch] = Sample(framePtr, ch, format.Kind);
                }
                // Ignore extra source channels above MaxChannels.
                _ = sourceChannels;
            }
        }
    }

    static unsafe float Sample(byte* frame, int channel, Kind kind)
    {
        switch (kind)
        {
            case Kind.Float32:
                return Finite(((float*)frame)[channel]);
            case Kind.Float64:
                return Finite((float)((double*)frame)[channel]);
            case Kind.Int16:
                return ((short*)frame)[channel] / 32768f;
            case Kind.Int32:
                return ((int*)frame)[channel] / 2147483648f;
            case Kind.Int24In32:
                return (((int*)frame)[channel] >> 8) / 8388608f;
            case Kind.Int24Packed:
            {
                var p = frame + channel * 3;
                var value = p[0] | (p[1] << 8) | (p[2] << 16);
                if ((value & 0x800000) != 0)
                    value |= unchecked((int)0xFF000000);
                return value / 8388608f;
            }
            default:
                return 0f;
        }
    }

    static float Finite(float value) => float.IsFinite(value) ? value : 0f;

    enum Kind
    {
        Float32,
        Float64,
        Int16,
        Int32,
        Int24In32,
        Int24Packed,
    }

    readonly record struct MixFormat(
        int Channels,
        uint SampleRate,
        ushort BlockAlign,
        Kind Kind,
        ushort DeclaredChannels);

    sealed class DeviceChangeListener : WasapiNative.IMMNotificationClient
    {
        readonly Action _onDefaultChanged;

        public DeviceChangeListener(Action onDefaultChanged) => _onDefaultChanged = onDefaultChanged;

        public int OnDeviceStateChanged(string deviceId, uint newState) => 0;
        public int OnDeviceAdded(string deviceId) => 0;
        public int OnDeviceRemoved(string deviceId) => 0;

        public int OnDefaultDeviceChanged(int flow, int role, string defaultDeviceId)
        {
            if (flow == WasapiNative.DataFlowRender)
                _onDefaultChanged();
            return 0;
        }

        public int OnPropertyValueChanged(string deviceId, WasapiNative.PropertyKey key) => 0;
    }
}
