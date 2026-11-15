using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player.Core.Tests;

public class LaunchEntryQueueTests
{
    [Fact]
    public void HoldsUrlUntilStart()
    {
        var delivered = new List<EntryPoint>();
        var queue = new LaunchEntryQueue(delivered.Add);
        var url = new Uri("rgbprompt://play?t=abc&v=1");
        queue.Submit(new EntryPoint.PlayerUrl(url));
        Assert.Equal(1, queue.PendingCount);
        Assert.Empty(delivered);
        queue.Start();
        Assert.Equal(new EntryPoint.PlayerUrl(url), Assert.Single(delivered));
        Assert.Equal(0, queue.PendingCount);
    }

    [Fact]
    public void DropsDuplicateColdStartUrl()
    {
        var delivered = new List<EntryPoint>();
        var queue = new LaunchEntryQueue(delivered.Add);
        var url = new Uri("rgbprompt://play?t=abc&v=1");
        queue.Submit(new EntryPoint.PlayerUrl(url));
        queue.Submit(new EntryPoint.PlayerUrl(url));
        queue.Submit(new EntryPoint.PlayerUrl(url));
        queue.Start();
        Assert.Equal(new EntryPoint.PlayerUrl(url), Assert.Single(delivered));
    }

    [Fact]
    public void AfterStartSkipsImmediateRepeatButAllowsNewToken()
    {
        var delivered = new List<EntryPoint>();
        var queue = new LaunchEntryQueue(delivered.Add);
        queue.Start();
        var first = new Uri("rgbprompt://play?t=aaa&v=1");
        var second = new Uri("rgbprompt://play?t=bbb&v=1");
        queue.Submit(new EntryPoint.PlayerUrl(first));
        queue.Submit(new EntryPoint.PlayerUrl(first));
        queue.Submit(new EntryPoint.PlayerUrl(second));
        Assert.Equal(
            new EntryPoint[] { new EntryPoint.PlayerUrl(first), new EntryPoint.PlayerUrl(second) },
            delivered);
    }
}
