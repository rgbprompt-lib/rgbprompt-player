using Microsoft.Win32;
using RGBPrompt.Player.Core.Services;

namespace RGBPrompt.Player.Services;

public static class ProtocolRegistrationService
{
    /// <summary>
    /// Official per-user install directory written by tools/win/setup.iss.
    /// Daily development / Release builds run from the artifacts tree and
    /// must not take over rgbprompt:// or .lep.
    /// </summary>
    public static bool IsOfficialInstall(string exePath)
    {
        if (string.IsNullOrWhiteSpace(exePath)) return false;
        try
        {
            var officialRoot = Path.GetFullPath(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "RGBPrompt"));
            exePath = Path.GetFullPath(exePath);
            var prefix = officialRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            return exePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    public static void EnsureRegistered(string exePath)
    {
        if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath)) return;
        // Official installers already write HKCU. Only repair the association
        // when running from that official directory; never from a dev build.
        if (!IsOfficialInstall(exePath)) return;
        try
        {
            using (var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProtocolRegistration.ProtocolName}"))
            {
                key?.SetValue("", "URL:RGBPrompt Protocol");
                key?.SetValue("URL Protocol", "");
                using var cmd = key?.CreateSubKey(@"shell\open\command");
                cmd?.SetValue("", ProtocolRegistration.ProtocolCommand(exePath));
            }

            using (var ext = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProtocolRegistration.FileExtension}"))
            {
                ext?.SetValue("", ProtocolRegistration.ProgId);
            }
            using (var prog = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProtocolRegistration.ProgId}"))
            {
                prog?.SetValue("", "RGBPrompt Lighting Effect");
                using var cmd = prog?.CreateSubKey(@"shell\open\command");
                cmd?.SetValue("", ProtocolRegistration.FileCommand(exePath));
            }
        }
        catch
        {
            // Registration is best-effort; play still works via explicit argv.
        }
    }

    public static bool IsRegistered()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                $@"Software\Classes\{ProtocolRegistration.ProtocolName}\shell\open\command");
            return key?.GetValue("") is string command && command.Length > 0;
        }
        catch
        {
            return false;
        }
    }
}
