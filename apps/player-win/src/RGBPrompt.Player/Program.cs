using System.Threading;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
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
            SingleInstance.ForwardArgsAndExit(args);
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
