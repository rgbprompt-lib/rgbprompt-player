using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player.Core.Tests;

public class BridgeConfigTests
{
    [Fact]
    public void ResolveApiBase_PrefersEnv()
    {
        Assert.Equal(
            "http://127.0.0.1:8787/api",
            BridgeConfigBuilder.ResolveApiBase("http://127.0.0.1:8787/api/", "https://stored", null));
    }

    [Fact]
    public void LanguageFromCulture_ZhBecomesZhCN()
    {
        Assert.Equal("zh-CN", BridgeConfigBuilder.LanguageFromCulture("zh-Hans-CN"));
        Assert.Equal("en", BridgeConfigBuilder.LanguageFromCulture("en-US"));
    }

    [Fact]
    public void NormalizeOsVersion_Parses()
    {
        Assert.Equal("10.0.22631", BridgeConfigBuilder.NormalizeOsVersion("Microsoft Windows NT 10.0.22631.0"));
    }
}
