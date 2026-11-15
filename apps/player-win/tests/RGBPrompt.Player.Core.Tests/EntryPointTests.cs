using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player.Core.Tests;

public class EntryPointTests
{
    [Fact]
    public void Classify_PlayUrl_AndLep()
    {
        var play = new Uri("rgbprompt://play?t=abc&v=1");
        Assert.Equal(new EntryPoint.PlayerUrl(play), EntryPoint.Classify(play));

        var lep = new Uri("file:///C:/tmp/effect.lep");
        Assert.IsType<EntryPoint.LepFile>(EntryPoint.Classify(lep));

        Assert.IsType<EntryPoint.Ignored>(EntryPoint.Classify(new Uri("https://rgbprompt.com")));
    }

    [Fact]
    public void RevealsPanel_OnlyExplicitOpenHost()
    {
        Assert.True(new EntryPoint.PlayerUrl(new Uri("rgbprompt://open")).RevealsPanel);
        Assert.True(new EntryPoint.PlayerUrl(new Uri("rgbprompt://OPEN")).RevealsPanel);
        Assert.False(new EntryPoint.PlayerUrl(new Uri("rgbprompt://play?t=abc&v=1")).RevealsPanel);
        Assert.False(new EntryPoint.PlayerUrl(new Uri("rgbprompt://token/xyz")).RevealsPanel);
        Assert.False(new EntryPoint.LepFile(@"C:\tmp\effect.lep").RevealsPanel);
        Assert.False(new EntryPoint.Ignored().RevealsPanel);
    }

    [Fact]
    public void FromLaunchArguments_PicksFirstPlayable()
    {
        var entry = EntryPoint.FromLaunchArguments(new[] { "RGBPrompt.Player.exe", "rgbprompt://open" });
        Assert.NotNull(entry);
        Assert.True(entry!.RevealsPanel);
    }

    [Fact]
    public void CollectLaunchEntries_ReadsCommandLineAndActivationWhenMainArgsEmpty()
    {
        var exe = new[] { "RGBPrompt.Player.exe" };
        var process = new[] { "RGBPrompt.Player.exe", "rgbprompt://play?t=abc&v=1" };
        var entries = EntryPoint.CollectLaunchEntries(exe, process, null).ToList();
        Assert.Single(entries);
        Assert.IsType<EntryPoint.PlayerUrl>(entries[0]);

        var fromActivation = EntryPoint.CollectLaunchEntries(
            exe, exe, "rgbprompt://play?t=def&v=1").ToList();
        Assert.Single(fromActivation);
        Assert.Equal(new Uri("rgbprompt://play?t=def&v=1"), ((EntryPoint.PlayerUrl)fromActivation[0]).Url);
    }
}
