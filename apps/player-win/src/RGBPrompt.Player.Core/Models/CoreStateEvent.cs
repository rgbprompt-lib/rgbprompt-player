namespace RGBPrompt.Player.Core.Models;

/// <summary>Managed copy of <c>RgbpStateEvent</c>. C strings are copied before leaving the callback.</summary>
public sealed record CoreStateEvent(
    int State,
    int Error = 0,
    string EffectName = "",
    string KeyboardName = "",
    int KeyboardSupport = -1,
    uint Fps = 0,
    int DriverProgress = -1,
    int DriverError = 0,
    string? ConflictName = null);
