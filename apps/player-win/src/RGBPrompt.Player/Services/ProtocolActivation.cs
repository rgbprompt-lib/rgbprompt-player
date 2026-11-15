using Microsoft.Windows.AppLifecycle;

namespace RGBPrompt.Player.Services;

/// <summary>
/// Reads a protocol activation URI from Windows App SDK when Main argv is empty.
/// Unpackaged WinUI apps do not always receive <c>rgbprompt://</c> in Main args.
/// </summary>
static class ProtocolActivation
{
    public static string? UriString()
    {
        try
        {
            var args = AppInstance.GetCurrent().GetActivatedEventArgs();
            if (args is null || args.Kind != ExtendedActivationKind.Protocol)
                return null;
            if (args.Data is Windows.ApplicationModel.Activation.IProtocolActivatedEventArgs protocol)
                return protocol.Uri?.AbsoluteUri;
            return null;
        }
        catch
        {
            return null;
        }
    }
}
