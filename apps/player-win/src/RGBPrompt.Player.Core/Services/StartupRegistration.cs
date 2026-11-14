namespace RGBPrompt.Player.Core.Services;

/// <summary>HKCU Run key used for launch-at-login (M6-W4).</summary>
public static class StartupRegistration
{
    public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string ValueName = "RGBPromptPlayer";

    public static string Command(string exePath) => $"\"{exePath}\"";
}
