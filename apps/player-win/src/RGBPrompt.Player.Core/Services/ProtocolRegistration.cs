namespace RGBPrompt.Player.Core.Services;

/// <summary>
/// Describes the HKCU protocol / file-association values the WinUI shell writes
/// (PLAYER §9.2). The shell applies them via Microsoft.Win32.Registry.
/// </summary>
public static class ProtocolRegistration
{
    public const string ProtocolName = "rgbprompt";
    public const string FileExtension = ".lep";
    public const string ProgId = "RGBPrompt.lep";

    public static string ProtocolCommand(string exePath) =>
        $"\"{exePath}\" \"%1\"";

    public static string FileCommand(string exePath) =>
        $"\"{exePath}\" \"%1\"";
}
