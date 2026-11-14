using Microsoft.Win32;
using RGBPrompt.Player.Core.Services;

namespace RGBPrompt.Player.Services;

public static class StartupRegistrationService
{
    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(StartupRegistration.RunKeyPath, writable: false);
        return key?.GetValue(StartupRegistration.ValueName) is string;
    }

    public static void SetEnabled(bool enabled, string exePath)
    {
        using var key = Registry.CurrentUser.OpenSubKey(StartupRegistration.RunKeyPath, writable: true)
            ?? Registry.CurrentUser.CreateSubKey(StartupRegistration.RunKeyPath);
        if (key is null) return;
        if (enabled)
            key.SetValue(StartupRegistration.ValueName, StartupRegistration.Command(exePath));
        else
            key.DeleteValue(StartupRegistration.ValueName, throwOnMissingValue: false);
    }
}
