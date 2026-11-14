namespace RGBPrompt.Player.Core.Models;

public enum KeyboardSupport
{
    Unknown = -1,
    PerKey = 0,
    Zones = 1,
    Single = 2,
}

public static class KeyboardSupportExtensions
{
    public static string LocalizationKey(this KeyboardSupport support) => support switch
    {
        KeyboardSupport.Unknown => "support.unknown",
        KeyboardSupport.PerKey => "support.perKey",
        KeyboardSupport.Zones => "support.zones",
        KeyboardSupport.Single => "support.single",
        _ => "support.unknown",
    };

    public static KeyboardSupport FromCode(int code) =>
        Enum.IsDefined(typeof(KeyboardSupport), code) ? (KeyboardSupport)code : KeyboardSupport.Unknown;
}

/// <summary>Shell panel state mirrored from the C ABI state machine (PLAYER §6).</summary>
public abstract record PanelState
{
    public sealed record Idle(FailureCode? Failure) : PanelState;
    public sealed record Preparing : PanelState;
    public sealed record NeedsDriver(int? Progress, int DriverError) : PanelState;
    public sealed record NoKeyboard(bool DeviceLost) : PanelState;
    public sealed record Playing : PanelState;
    public sealed record BackendUnresponsive : PanelState;
    public sealed record VendorConflict(string? Name) : PanelState;
    public sealed record Blocked : PanelState;
    public sealed record CoreUnavailable : PanelState;

    public static PanelState FromEvent(CoreStateEvent ev) => ev.State switch
    {
        0 => new Idle(FailureCodeExtensions.FromCode(ev.Error)),
        1 => new Preparing(),
        2 => new NeedsDriver(ev.DriverProgress >= 0 ? ev.DriverProgress : null, ev.DriverError),
        3 => new NoKeyboard(ev.Error == (int)FailureCode.DeviceLost),
        4 => new Playing(),
        5 => new BackendUnresponsive(),
        6 => new VendorConflict(string.IsNullOrWhiteSpace(ev.ConflictName) ? null : ev.ConflictName),
        7 => new Blocked(),
        _ => new CoreUnavailable(),
    };

    public bool IsPlaying => this is Playing;

    public string StatusLocalizationKey => this switch
    {
        Playing or Idle => "panel.status.connected",
        Preparing => "panel.status.preparing",
        NeedsDriver => "panel.status.driverNeeded",
        NoKeyboard => "panel.status.noKeyboard",
        BackendUnresponsive => "panel.status.backendUnresponsive",
        VendorConflict => "panel.status.vendorConflict",
        Blocked => "panel.status.blocked",
        CoreUnavailable => "panel.status.internalError",
        _ => "panel.status.internalError",
    };
}

public enum StatusBadge
{
    None,
    Playing,
    Attention,
}

public static class StatusBadgeMapping
{
    public static StatusBadge From(PanelState state) => state switch
    {
        PanelState.Playing => StatusBadge.Playing,
        PanelState.NeedsDriver or PanelState.NoKeyboard or PanelState.BackendUnresponsive
            or PanelState.VendorConflict or PanelState.Blocked or PanelState.CoreUnavailable
            => StatusBadge.Attention,
        PanelState.Idle idle => idle.Failure is null ? StatusBadge.None : StatusBadge.Attention,
        PanelState.Preparing => StatusBadge.None,
        _ => StatusBadge.None,
    };
}
