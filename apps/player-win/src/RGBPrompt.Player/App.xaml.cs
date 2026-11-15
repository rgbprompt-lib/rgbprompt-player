using System.IO.Pipes;
using System.Threading;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using RGBPrompt.Player.Core.Models;
using RGBPrompt.Player.Services;
using RGBPrompt.Player.Tray;

namespace RGBPrompt.Player;

public partial class App : Application
{
    readonly string[] _launchArgs;
    readonly NamedPipeServerStream? _pipeServer;
    AppController? _controller;
    LaunchEntryQueue? _launchQueue;
    int _shutdownStarted;

    public App(string[] launchArgs, NamedPipeServerStream? pipeServer)
    {
        _launchArgs = launchArgs;
        _pipeServer = pipeServer;
        UnhandledException += (_, e) => CrashLog.Write("XAML", e.Exception);
        InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            Launch();
        }
        catch (Exception ex)
        {
            CrashLog.Write("OnLaunched", ex);
            throw;
        }
    }

    /// <summary>
    /// Quit path: cancel the single-instance pipe, dispose the controller/core
    /// (stop playback and the managed helper), then exit the process.
    /// Idempotent: a second call returns immediately.
    /// A bounded watchdog is armed first so an unbounded <c>rgbp_destroy</c>
    /// join cannot prevent process exit. The watchdog is a last resort, not a
    /// substitute for the cleanup below. Logs are appended, never deleted.
    /// </summary>
    public void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdownStarted, 1) != 0)
            return;

        // rgbp_destroy joins the control thread, which wait()s the managed
        // helper with no timeout. Arm the watchdog before that join.
        const int graceMilliseconds = 5000;
        var cleanupFinished = new ManualResetEventSlim(false);
        var watchdog = new Thread(() =>
        {
            if (!cleanupFinished.Wait(graceMilliseconds))
            {
                CrashLog.Write(
                    "Shutdown.watchdog",
                    new TimeoutException($"controller dispose exceeded {graceMilliseconds}ms"));
                Environment.Exit(0);
            }
        })
        {
            IsBackground = true,
            Name = "RGBPrompt.ShutdownWatchdog"
        };
        watchdog.Start();

        try { _pipeServer?.Dispose(); } catch (Exception ex) { CrashLog.Write("Shutdown.pipe", ex); }
        var controller = _controller;
        _controller = null;
        try { controller?.Dispose(); } catch (Exception ex) { CrashLog.Write("Shutdown.controller", ex); }
        try { Application.Current?.Exit(); } catch (Exception ex) { CrashLog.Write("Shutdown.exit", ex); }
        cleanupFinished.Set();
        Environment.Exit(0);
    }

    void Launch()
    {
        _launchQueue = new LaunchEntryQueue(entry => _controller?.Open(entry));

        // Listen before constructing the controller so a second process that
        // races WinUI / core startup can still forward its play URL.
        if (_pipeServer != null)
        {
            var dispatcher = DispatcherQueue.GetForCurrentThread();
            _ = SingleInstance.ListenForForwardedArgs(_pipeServer, line =>
            {
                void submit() => _launchQueue?.Submit(EntryPoint.ClassifyPathOrUrl(line));
                if (!dispatcher.HasThreadAccess)
                    dispatcher.TryEnqueue(submit);
                else
                    submit();
            });
        }

        _controller = new AppController();
        _controller.Start();

        // Launch argv / protocol activation — play without revealing the panel
        // unless EntryPoint.RevealsPanel (rgbprompt://open only).
        foreach (var entry in EntryPoint.CollectLaunchEntries(
            new[] { Environment.ProcessPath ?? "RGBPrompt.Player" }.Concat(_launchArgs),
            Environment.GetCommandLineArgs(),
            ProtocolActivation.UriString()))
        {
            _launchQueue.Submit(entry);
        }
        _launchQueue.Start();

        ProtocolRegistrationService.EnsureRegistered(Environment.ProcessPath ?? "");
    }
}
