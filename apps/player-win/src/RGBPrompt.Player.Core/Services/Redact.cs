namespace RGBPrompt.Player.Core.Services;

public static class Redact
{
    /// <summary>Truncate token query values so logs never hold a full play token.</summary>
    public static string PlayerUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return "rgbprompt://…";
        var builder = new UriBuilder(uri) { Fragment = "" };
        if (string.IsNullOrEmpty(uri.Query)) return builder.Uri.GetLeftPart(UriPartial.Path);
        var parts = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries);
        var redacted = new List<string>();
        foreach (var part in parts)
        {
            var kv = part.Split('=', 2);
            if (kv.Length == 2 && (kv[0] is "t" or "token") && kv[1].Length > 6)
                redacted.Add($"{kv[0]}={kv[1][..6]}…");
            else
                redacted.Add(part);
        }
        builder.Query = string.Join('&', redacted);
        return builder.Uri.ToString();
    }
}
