namespace RGBPrompt.Player.Core.Models;

/// <summary>How the shell was asked to play something (PLY-04).</summary>
public abstract record EntryPoint
{
    public sealed record PlayerUrl(Uri Url) : EntryPoint;
    public sealed record LepFile(string Path) : EntryPoint;
    public sealed record Ignored : EntryPoint;

    /// <summary>
    /// Whether opening this entry should reveal the tray panel.
    /// Only the explicit <c>rgbprompt://open</c> host may show it; play/push and
    /// <c>.lep</c> opens keep the panel's current visibility (hidden stays hidden).
    /// </summary>
    public bool RevealsPanel => this switch
    {
        PlayerUrl u => string.Equals(u.Url.Host, "open", StringComparison.OrdinalIgnoreCase),
        _ => false,
    };

    public static EntryPoint Classify(Uri url)
    {
        if (string.Equals(url.Scheme, "rgbprompt", StringComparison.OrdinalIgnoreCase))
            return new PlayerUrl(url);
        if (url.IsFile && url.LocalPath.EndsWith(".lep", StringComparison.OrdinalIgnoreCase))
            return new LepFile(url.LocalPath);
        return new Ignored();
    }

    public static EntryPoint ClassifyPathOrUrl(string argument)
    {
        if (Uri.TryCreate(argument, UriKind.Absolute, out var uri) &&
            string.Equals(uri.Scheme, "rgbprompt", StringComparison.OrdinalIgnoreCase))
            return new PlayerUrl(uri);
        if (argument.EndsWith(".lep", StringComparison.OrdinalIgnoreCase))
            return new LepFile(System.IO.Path.GetFullPath(argument));
        return new Ignored();
    }

    public static EntryPoint? FromLaunchArguments(IEnumerable<string> arguments)
    {
        foreach (var argument in arguments.Skip(1))
        {
            var entry = ClassifyPathOrUrl(argument);
            if (entry is not Ignored) return entry;
        }
        return null;
    }
}
