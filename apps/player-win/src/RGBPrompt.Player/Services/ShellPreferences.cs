using System.Text.Json;
using System.Text.Json.Nodes;

namespace RGBPrompt.Player;

/// <summary>
/// Persisted shell preferences in <c>%LOCALAPPDATA%\RGBPrompt\preferences.json</c>:
/// <c>language</c>, <c>brightness</c> and the keyboard picked in the panel's ⋯ menu (the Mac keeps
/// the same choice in <c>KeyboardPreference</c>).
/// </summary>
public static class ShellPreferences
{
    public static string? LoadLanguage(string dataDir)
    {
        var raw = Read(dataDir, "language");
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return raw.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? "zh-CN" : "en";
    }

    public static void SaveLanguage(string dataDir, string language) =>
        Write(dataDir, "language", language.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? "zh-CN" : "en");

    public static string? LoadKeyboard(string dataDir) =>
        Read(dataDir, "keyboard") is { Length: > 0 } name ? name : null;

    public static void SaveKeyboard(string dataDir, string name) => Write(dataDir, "keyboard", name.Trim());

    public static int? LoadBrightness(string dataDir) =>
        int.TryParse(Read(dataDir, "brightness"), System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture, out var value) ? value : null;

    public static void SaveBrightness(string dataDir, int value) =>
        Write(dataDir, "brightness", value.ToString(System.Globalization.CultureInfo.InvariantCulture));

    static string? Read(string dataDir, string key)
    {
        try
        {
            var path = Path.Combine(dataDir, "preferences.json");
            if (!File.Exists(path)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            return doc.RootElement.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    static void Write(string dataDir, string key, string value)
    {
        try
        {
            Directory.CreateDirectory(dataDir);
            var path = Path.Combine(dataDir, "preferences.json");
            JsonObject root;
            try
            {
                root = File.Exists(path) && JsonNode.Parse(File.ReadAllText(path)) is JsonObject existing
                    ? existing
                    : new JsonObject();
            }
            catch (JsonException)
            {
                root = new JsonObject();
            }
            root[key] = value;
            File.WriteAllText(path, root.ToJsonString());
        }
        catch
        {
            // Best-effort; the session value still updates in memory.
        }
    }
}
