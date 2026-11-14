namespace RGBPrompt.Player.Core.Models;

/// <summary>
/// Which backend card to show (same mapping as the Mac PlayerKit
/// <c>BackendIssue</c>): the supervision block from <c>rgbp_driver_info_json</c>
/// says whether Player is restarting its own driver or waiting for the user's
/// OpenRGB to come back.
/// </summary>
public abstract record BackendIssue
{
    public sealed record Restarting(int Attempt, int Limit) : BackendIssue;
    public sealed record GaveUp : BackendIssue;
    public sealed record ExternalLost(int Port) : BackendIssue;
    public sealed record Unresponsive : BackendIssue;

    public static BackendIssue? From(PanelState state, DriverInfo? info)
    {
        if (state is not PanelState.BackendUnresponsive) return null;
        return info?.Supervision?.State switch
        {
            "restarting" => new Restarting(
                Math.Max(1, info.Supervision.Crashes ?? 1),
                Math.Max(1, info.Supervision.CrashLimit ?? 3)),
            "gaveUp" => new GaveUp(),
            "externalLost" => new ExternalLost(info.Port ?? 6742),
            _ => new Unresponsive(),
        };
    }

    public string HeaderStatusKey => this switch
    {
        Restarting => "panel.status.restartingDriver",
        ExternalLost => "panel.status.openrgbNotRunning",
        _ => "panel.status.backendUnresponsive",
    };
}
