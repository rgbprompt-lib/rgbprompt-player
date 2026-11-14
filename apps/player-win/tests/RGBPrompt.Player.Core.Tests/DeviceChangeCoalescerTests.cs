using RGBPrompt.Player.Core.Input;

namespace RGBPrompt.Player.Core.Tests;

public class DeviceChangeCoalescerTests
{
    [Fact]
    public void CoalescesBurstIntoOneFlush()
    {
        Action? pending = null;
        var coalescer = new DeviceChangeCoalescer(
            delay: TimeSpan.FromMilliseconds(300),
            schedule: (_, action) => pending = action);

        var flushes = new List<(int added, int removed)>();
        coalescer.OnFlush = (added, removed) => flushes.Add((added, removed));

        coalescer.Record(added: 1);
        coalescer.Record(removed: 1);
        coalescer.Record(added: 2);
        Assert.NotNull(pending);
        Assert.Empty(flushes);

        pending!();
        Assert.Equal(new[] { (3, 1) }, flushes);
    }

    [Fact]
    public void SchedulesAgainAfterFlush()
    {
        var scheduled = new List<Action>();
        var coalescer = new DeviceChangeCoalescer(
            delay: TimeSpan.FromMilliseconds(300),
            schedule: (_, action) => scheduled.Add(action));

        var flushes = 0;
        coalescer.OnFlush = (_, _) => flushes++;

        coalescer.Record(added: 1);
        Assert.Single(scheduled);
        scheduled[0]();
        Assert.Equal(1, flushes);

        coalescer.Record(removed: 1);
        Assert.Equal(2, scheduled.Count);
        scheduled[1]();
        Assert.Equal(2, flushes);
    }
}
