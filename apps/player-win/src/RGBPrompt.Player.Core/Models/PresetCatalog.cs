using System.Text.Json;

namespace RGBPrompt.Player.Core.Models;

/// <summary>One built-in effect. Same fields as the Mac Player's PlayerPreset.</summary>
public sealed record PlayerPreset(
    string Id,
    string FileName,
    string NameZh,
    string NameEn,
    bool HasAudio,
    int Order,
    string? FilePath,
    bool NeedsKeys,
    IReadOnlyList<byte> Thumbnail);

/// <summary>
/// Loads the built-in effects from <c>Presets\manifest.json</c> next to the exe.
/// The files are the Mac Player's <c>apps/player-mac/Resources/Presets</c>, linked
/// into the build (one source for both platforms). <c>thumbnails.json</c> is
/// optional and supplies the key-reactive flag and one rendered frame.
/// </summary>
public static class PresetCatalog
{
    public const string DirectoryName = "Presets";

    /// <summary>Largest .lep compared byte-for-byte when matching an opened file.</summary>
    public const int MaxMatchBytes = 64 * 1024;

    public static string DefaultDirectory =>
        Path.Combine(AppContext.BaseDirectory, DirectoryName);

    public static IReadOnlyList<PlayerPreset> Load(string? directory = null)
    {
        var dir = directory ?? DefaultDirectory;
        var manifest = Path.Combine(dir, "manifest.json");
        if (!File.Exists(manifest)) return Array.Empty<PlayerPreset>();

        JsonElement list;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(manifest));
            if (!doc.RootElement.TryGetProperty("presets", out var presets) ||
                presets.ValueKind != JsonValueKind.Array)
                return Array.Empty<PlayerPreset>();
            list = presets.Clone();
        }
        catch (JsonException)
        {
            return Array.Empty<PlayerPreset>();
        }

        var thumbnails = LoadThumbnails(dir);
        var result = new List<PlayerPreset>();
        foreach (var item in list.EnumerateArray())
        {
            var id = GetString(item, "id");
            var file = GetString(item, "file");
            var nameZh = GetString(item, "name_zh");
            var nameEn = GetString(item, "name_en");
            if (id is null || file is null || nameZh is null || nameEn is null) continue;
            var hasAudio = item.TryGetProperty("hasAudio", out var a) && a.ValueKind == JsonValueKind.True;
            var order = item.TryGetProperty("order", out var o) && o.TryGetInt32(out var n) ? n : 0;
            var path = Path.Combine(dir, file);
            thumbnails.TryGetValue(id, out var thumb);
            result.Add(new PlayerPreset(
                id, file, nameZh, nameEn, hasAudio, order,
                File.Exists(path) ? path : null,
                thumb.NeedsKeys,
                thumb.Rgb ?? Array.Empty<byte>()));
        }
        return result.OrderBy(p => p.Order).ToList();
    }

    public static string DisplayName(PlayerPreset preset, string language) =>
        language.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? preset.NameZh : preset.NameEn;

    /// <summary>
    /// A copy of a built-in effect opened from Explorer plays as that preset
    /// (same rule as the Mac Player: identical bytes, at most 64 KB).
    /// </summary>
    public static string? MatchBundled(string path, IReadOnlyList<PlayerPreset> presets)
    {
        byte[] data;
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > MaxMatchBytes) return null;
            data = File.ReadAllBytes(path);
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }

        foreach (var preset in presets)
        {
            if (preset.FilePath is null) continue;
            try
            {
                if (File.ReadAllBytes(preset.FilePath).AsSpan().SequenceEqual(data)) return preset.Id;
            }
            catch (IOException) { }
        }
        return null;
    }

    static Dictionary<string, (bool NeedsKeys, byte[]? Rgb)> LoadThumbnails(string dir)
    {
        var result = new Dictionary<string, (bool, byte[]?)>();
        var path = Path.Combine(dir, "thumbnails.json");
        if (!File.Exists(path)) return result;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
            if (!doc.RootElement.TryGetProperty("presets", out var presets) ||
                presets.ValueKind != JsonValueKind.Object)
                return result;
            foreach (var entry in presets.EnumerateObject())
            {
                var needsKeys = entry.Value.TryGetProperty("needsKeys", out var k) && k.ValueKind == JsonValueKind.True;
                byte[]? rgb = null;
                if (entry.Value.TryGetProperty("rgb", out var r) && r.ValueKind == JsonValueKind.Array)
                {
                    rgb = r.EnumerateArray()
                        .Select(v => v.TryGetInt32(out var x) ? (byte)Math.Clamp(x, 0, 255) : (byte)0)
                        .ToArray();
                }
                result[entry.Name] = (needsKeys, rgb);
            }
        }
        catch (JsonException) { }
        return result;
    }

    static string? GetString(JsonElement item, string name) =>
        item.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}

/// <summary>Panel wording for the preset list, copied from the Mac Player's Localizable.strings.</summary>
public static class PresetStrings
{
    public static string Title(string language) => IsZh(language) ? "预设灯效" : "Presets";
    public static string Audio(string language) => IsZh(language) ? "声控" : "Audio";
    public static string Playing(string language) => IsZh(language) ? "播放中" : "Playing";
    public static string SourcePreset(string language) => IsZh(language) ? "内置灯效" : "Built-in effect";

    static bool IsZh(string language) => language.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
}
