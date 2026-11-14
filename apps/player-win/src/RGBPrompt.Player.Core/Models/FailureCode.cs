namespace RGBPrompt.Player.Core.Models;

/// <summary>Every <c>RGBP_ERR_*</c> status code from the C ABI.</summary>
public enum FailureCode
{
    InternalError = -1,
    UpdateRequired = -2,
    DecodeFailed = -3,
    LinkUnavailable = -4,
    DriverDeclined = -5,
    OpenRgbUnreachable = -6,
    DeviceLost = -7,
    UnsupportedPackage = -8,
    InvalidArgument = -100,
    BufferTooSmall = -101,
    NotSupported = -102,
    BadUrl = -103,
}

public static class FailureCodeExtensions
{
    public static FailureCode? FromCode(int code) =>
        Enum.IsDefined(typeof(FailureCode), code) ? (FailureCode)code : null;

    public static string LocalizationKey(this FailureCode code) => code switch
    {
        FailureCode.InternalError => "failure.internal",
        FailureCode.UpdateRequired => "failure.updateRequired",
        FailureCode.DecodeFailed => "failure.decodeFailed",
        FailureCode.LinkUnavailable => "failure.linkUnavailable",
        FailureCode.DriverDeclined => "failure.driverDeclined",
        FailureCode.OpenRgbUnreachable => "failure.openrgbUnreachable",
        FailureCode.DeviceLost => "failure.deviceLost",
        FailureCode.UnsupportedPackage => "failure.unsupportedPackage",
        FailureCode.InvalidArgument => "failure.invalidArgument",
        FailureCode.BufferTooSmall => "failure.bufferTooSmall",
        FailureCode.NotSupported => "failure.notSupported",
        FailureCode.BadUrl => "failure.badUrl",
        _ => "failure.internal",
    };
}

public abstract record BridgeError
{
    public sealed record CoreUnavailable : BridgeError;
    public sealed record Failure(FailureCode Code) : BridgeError;
    public sealed record Unknown(int Code) : BridgeError;

    public static BridgeError? From(int code)
    {
        if (code == 0) return null;
        var known = FailureCodeExtensions.FromCode(code);
        return known is { } f ? new Failure(f) : new Unknown(code);
    }
}
