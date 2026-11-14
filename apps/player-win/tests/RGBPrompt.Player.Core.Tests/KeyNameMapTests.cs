using RGBPrompt.Player.Core.Input;

namespace RGBPrompt.Player.Core.Tests;

public class KeyNameMapTests
{
    [Fact]
    public void MapsCommonVks()
    {
        Assert.Equal("A", KeyNameMap.Name(0x41));
        Assert.Equal("ESC", KeyNameMap.Name(0x1B));
        Assert.Equal("ENTER", KeyNameMap.Name(0x0D, extended: false));
        Assert.Equal("KP_ENTER", KeyNameMap.Name(0x0D, extended: true));
        Assert.Equal("RCTRL", KeyNameMap.Name(0x11, extended: true));
        Assert.Null(KeyNameMap.Name(0xE8));
    }

    [Fact]
    public void UsesEngineNamesForPeriodAndApplication()
    {
        Assert.Equal("PERIOD", KeyNameMap.Name(0xBE));
        Assert.Equal("KP_PERIOD", KeyNameMap.Name(0x6E));
        Assert.Equal("APPLICATION", KeyNameMap.Name(0x5D, extended: true));
    }

    [Fact]
    public void EveryMappedNameIsAnEngineKey()
    {
        // rgbp_push_key silently drops names the engine does not know, so a
        // typo here makes that key dead in key-reactive effects.
        var layout = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "KeyLayout.swift"));
        var engine = System.Text.RegularExpressions.Regex
            .Matches(layout, "name: \"([A-Z0-9_]+)\"")
            .Select(m => m.Groups[1].Value)
            .ToHashSet();
        Assert.Equal(104, engine.Count);

        var mapped = new HashSet<string>();
        for (var vk = 0; vk < 256; vk++)
        {
            foreach (var extended in new[] { false, true })
            {
                if (KeyNameMap.Name(vk, extended) is { } name)
                {
                    Assert.Contains(name, engine);
                    mapped.Add(name);
                }
            }
        }
        Assert.Equal(engine.Count, mapped.Count);
    }
}
