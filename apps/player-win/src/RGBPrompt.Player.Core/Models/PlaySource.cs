namespace RGBPrompt.Player.Core.Models;

public abstract record PlaySource
{
    public sealed record None : PlaySource;
    public sealed record Preset(string Id) : PlaySource;
    public sealed record Web : PlaySource;
    public sealed record File : PlaySource;
}
