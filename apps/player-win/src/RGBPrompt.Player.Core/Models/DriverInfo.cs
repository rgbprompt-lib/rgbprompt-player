using System.Text.Json.Serialization;

namespace RGBPrompt.Player.Core.Models;

/// <summary>JSON from <c>rgbp_driver_info_json</c> (PLAYER §9.0.2). Fields stay optional.</summary>
public sealed class DriverInfo
{
    public string? Variant { get; set; }
    public string? Version { get; set; }
    public long? SizeBytes { get; set; }
    public string? InstallDir { get; set; }
    public string? Source { get; set; }
    public string? License { get; set; }
    public bool? Installed { get; set; }
    public string? Mode { get; set; }
    public int? Port { get; set; }
    public string? Executable { get; set; }
    public bool? Verified { get; set; }
    public DriverSupervision? Supervision { get; set; }

    [JsonIgnore]
    public bool IsVerified => Verified == true;

    public string? WholeMegabytes()
    {
        if (SizeBytes is not > 0) return null;
        var mb = Math.Max(1, (int)Math.Round(SizeBytes.Value / (1024.0 * 1024.0)));
        return mb.ToString();
    }
}

public sealed class DriverSupervision
{
    public string? State { get; set; }
    public int? Crashes { get; set; }
    public int? CrashLimit { get; set; }
    public bool? External { get; set; }
}
