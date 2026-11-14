using System.IO.Pipes;
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

    void Launch()
    {
        _controller = new AppController();
        _controller.Start();

        // Launch argv / protocol activation — play without revealing the panel
        // unless EntryPoint.RevealsPanel (rgbprompt://open only).
        var entry = EntryPoint.FromLaunchArguments(
            new[] { Environment.ProcessPath ?? "RGBPrompt.Player" }.Concat(_launchArgs));
        if (entry != null)
            _controller.Open(entry);

        if (_pipeServer != null)
            _ = SingleInstance.ListenForForwardedArgs(_pipeServer, line =>
            {
                var forwarded = EntryPoint.ClassifyPathOrUrl(line);
                _controller?.Open(forwarded);
            });

        ProtocolRegistrationService.EnsureRegistered(Environment.ProcessPath ?? "");
    }
}
