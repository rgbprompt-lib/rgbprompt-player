namespace RGBPrompt.Player.Core.Models;

public sealed record BridgeConfig(
    string DataDir,
    string ApiBase,
    string Language,
    string AppVersion,
    string OsVersion,
    string? OpenRgbAddr);

public static class BridgeConfigBuilder
{
    public const string ProductionApiBase = "https://rgbprompt.com/api";

    public static string DataDirectory(string localAppData) =>
        Path.Combine(localAppData, "RGBPrompt");

    public static string ResolveApiBase(string? env, string? stored, string? embedded)
    {
        foreach (var candidate in new[] { env, stored, embedded })
        {
            if (!string.IsNullOrWhiteSpace(candidate))
                return TrimTrailingSlash(candidate.Trim());
        }
        return ProductionApiBase;
    }

    public static string? ResolveOpenRgbAddr(string? env, string? stored)
    {
        foreach (var candidate in new[] { env, stored })
        {
            if (!string.IsNullOrWhiteSpace(candidate))
                return candidate.Trim();
        }
        return null;
    }

    public static string LanguageFromCulture(string? cultureName)
    {
        if (string.IsNullOrWhiteSpace(cultureName)) return "en";
        return cultureName.StartsWith("zh", StringComparison.OrdinalIgnoreCase) ? "zh-CN" : "en";
    }

    public static string NormalizeOsVersion(string raw)
    {
        var m = System.Text.RegularExpressions.Regex.Match(raw, @"(\d+)\.(\d+)(?:\.(\d+))?");
        if (!m.Success) return "0.0.0";
        var patch = m.Groups[3].Success ? m.Groups[3].Value : "0";
        return $"{m.Groups[1].Value}.{m.Groups[2].Value}.{patch}";
    }

    public static Uri? SiteOrigin(string apiBase)
    {
        if (!Uri.TryCreate(apiBase, UriKind.Absolute, out var uri)) return null;
        var builder = new UriBuilder(uri) { Path = "", Query = "", Fragment = "" };
        var path = uri.AbsolutePath.TrimEnd('/');
        if (path.EndsWith("/api", StringComparison.OrdinalIgnoreCase))
            path = path[..^4];
        builder.Path = path;
        return builder.Uri;
    }

    public static Uri? StudioUrl(string apiBase) =>
        SiteOrigin(apiBase) is { } origin ? new Uri(origin, "app") : null;

    public static Uri? DownloadPageUrl(string apiBase) =>
        SiteOrigin(apiBase) is { } origin ? new Uri(origin, "player") : null;

    public static BridgeConfig Make(
        IReadOnlyDictionary<string, string> environment,
        string? storedApiBase,
        string? storedOpenRgb,
        string? embeddedApiBase,
        string appVersion,
        string osVersionString,
        string? cultureName,
        string localAppData)
    {
        environment.TryGetValue("RGBP_API_BASE", out var envApi);
        environment.TryGetValue("RGBP_OPENRGB_ADDR", out var envOpenRgb);
        var dataDir = DataDirectory(localAppData);
        Directory.CreateDirectory(dataDir);
        return new BridgeConfig(
            DataDir: dataDir,
            ApiBase: ResolveApiBase(envApi, storedApiBase, embeddedApiBase),
            Language: LanguageFromCulture(cultureName),
            AppVersion: string.IsNullOrWhiteSpace(appVersion) ? "0.0.0" : appVersion,
            OsVersion: NormalizeOsVersion(osVersionString),
            OpenRgbAddr: ResolveOpenRgbAddr(envOpenRgb, storedOpenRgb));
    }

    static string TrimTrailingSlash(string value) =>
        value.EndsWith('/') ? value[..^1] : value;
}
