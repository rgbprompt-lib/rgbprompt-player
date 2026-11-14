using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player.Core.Tests;

public class PanelStateTests
{
    [Fact]
    public void FromEvent_MapsAbiStates()
    {
        Assert.IsType<PanelState.Idle>(PanelState.FromEvent(new CoreStateEvent(0)));
        Assert.IsType<PanelState.Preparing>(PanelState.FromEvent(new CoreStateEvent(1)));
        Assert.IsType<PanelState.NeedsDriver>(PanelState.FromEvent(new CoreStateEvent(2, DriverProgress: 40)));
        Assert.IsType<PanelState.Playing>(PanelState.FromEvent(new CoreStateEvent(4)));
        Assert.IsType<PanelState.VendorConflict>(PanelState.FromEvent(new CoreStateEvent(6, ConflictName: "Razer Synapse")));
    }

    [Fact]
    public void StatusBadge_AttentionOnProblems()
    {
        Assert.Equal(StatusBadge.Playing, StatusBadgeMapping.From(new PanelState.Playing()));
        Assert.Equal(StatusBadge.Attention, StatusBadgeMapping.From(new PanelState.NeedsDriver(null, 0)));
        Assert.Equal(StatusBadge.None, StatusBadgeMapping.From(new PanelState.Idle(null)));
        Assert.Equal(StatusBadge.Attention, StatusBadgeMapping.From(new PanelState.Idle(FailureCode.DecodeFailed)));
    }

    [Fact]
    public void VendorConflictSession_DedupesNames()
    {
        var session = new VendorConflictSession();
        session.Note("Razer Synapse, iCUE");
        session.Note("Razer Synapse");
        session.Note("Armoury Crate");
        Assert.Equal(new[] { "Razer Synapse", "iCUE", "Armoury Crate" }, session.Names);
    }
}
