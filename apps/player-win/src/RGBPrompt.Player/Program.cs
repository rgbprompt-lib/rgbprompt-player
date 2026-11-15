using System.Threading;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using RGBPrompt.Player.Core.Models;
using RGBPrompt.Player.Services;

namespace RGBPrompt.Player;

/// <summary>Entry point. Single-instance: a second process forwards argv then exits.</summary>
public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        if (!SingleInstance.TryAcquire(out var pipeServer))
        {
            SingleInstance.ForwardArgsAndExit(LaunchForwardLines(args));
            return;
        }

        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            CrashLog.Write("AppDomain", e.ExceptionObject as Exception);

        WinRT.ComWrappersSupport.InitializeComWrappers();
        Application.Start(initParams =>
        {
            try
            {
                var context = new DispatcherQueueSynchronizationContext(
                    DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);
                _ = new App(args, pipeServer);
            }
            catch (Exception ex)
            {
                CrashLog.Write("Application.Start", ex);
                throw;
            }
        });
    }

    /// <summary>
    /// Prefer a concrete play URL / .lep path, including cases where unpackaged
    /// protocol activation left Main argv empty.
    /// </summary>
    static string[] LaunchForwardLines(string[] mainArgs)
    {
        var lines = new List<string>();
        foreach (var entry in EntryPoint.CollectLaunchEntries(
            new[] { Environment.ProcessPath ?? "RGBPrompt.Player" }.Concat(mainArgs),
            Environment.GetCommandLineArgs(),
            ProtocolActivation.UriString()))
        {
            switch (entry)
            {
                case EntryPoint.PlayerUrl url:
                    if (!lines.Contains(url.Url.AbsoluteUri))
                        lines.Add(url.Url.AbsoluteUri);
                    break;
                case EntryPoint.LepFile file:
                    if (!lines.Contains(file.Path))
                        lines.Add(file.Path);
                    break;
            }
        }
        return lines.Count > 0 ? lines.ToArray() : mainArgs;
    }
}

/// <summary>
/// Last-resort shell crash log (<c>%LOCALAPPDATA%\RGBPrompt\logs\shell-crash.log</c>).
/// The core's player.log only exists once the bridge is up, so XAML/startup
/// failures would otherwise leave nothing but a WER stowed-exception entry.
/// </summary>
static class CrashLog
{
    public static void Write(string where, Exception? ex)
    {
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RGBPrompt", "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "shell-crash.log"),
                $"{DateTime.Now:O} [{where}] {ex}\r\n");
        }
        catch
        {
            // Never let crash logging itself throw.
        }
    }
}
