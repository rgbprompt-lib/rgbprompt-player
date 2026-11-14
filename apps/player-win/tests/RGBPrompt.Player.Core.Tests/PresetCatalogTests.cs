using RGBPrompt.Player.Core.Models;

namespace RGBPrompt.Player.Core.Tests;

public class PresetCatalogTests
{
    // Linked from apps/player-mac/Resources/Presets (see the test csproj).
    static string PresetsDir => Path.Combine(AppContext.BaseDirectory, PresetCatalog.DirectoryName);

    static readonly string[] ExpectedIds =
    {
        "deep-breath", "cyber-rain", "aurora-curtain", "fingertip-ripple",
        "stardust", "tide-rainbow", "music-spectrum", "mirror-spectrum",
    };

    // packages/engine 0.6.0 writes LEP package version 12 (byte 4 of the LEP1 header).
    const byte CurrentPackageVersion = 12;

    [Fact]
    public void LoadsAllEightInMacOrder()
    {
        var presets = PresetCatalog.Load(PresetsDir);
        Assert.Equal(ExpectedIds, presets.Select(p => p.Id).ToArray());
        Assert.Equal(Enumerable.Range(1, 8), presets.Select(p => p.Order));
        Assert.All(presets, p => Assert.NotNull(p.FilePath));
    }

    [Fact]
    public void NamesAndAudioFlagsMatchMac()
    {
        var presets = PresetCatalog.Load(PresetsDir).ToDictionary(p => p.Id);
        Assert.Equal("深空呼吸", presets["deep-breath"].NameZh);
        Assert.Equal("Deep Breath", presets["deep-breath"].NameEn);
        Assert.Equal("律动镜像", presets["mirror-spectrum"].NameZh);
        Assert.True(presets["music-spectrum"].HasAudio);
        Assert.True(presets["mirror-spectrum"].HasAudio);
        Assert.False(presets["cyber-rain"].HasAudio);
        Assert.Equal("指尖涟漪", PresetCatalog.DisplayName(presets["fingertip-ripple"], "zh"));
        Assert.Equal("Fingertip Ripple", PresetCatalog.DisplayName(presets["fingertip-ripple"], "en"));
    }

    [Fact]
    public void EveryPresetIsACurrentPackageLep()
    {
        foreach (var preset in PresetCatalog.Load(PresetsDir))
        {
            var bytes = File.ReadAllBytes(preset.FilePath!);
            Assert.True(bytes.Length > 40, preset.Id);
            Assert.Equal("LEP1"u8.ToArray(), bytes[..4]);
            Assert.Equal(CurrentPackageVersion, bytes[4]);
        }
    }

    [Fact]
    public void ThumbnailsAreOneFrameOf104Keys()
    {
        var presets = PresetCatalog.Load(PresetsDir);
        Assert.All(presets, p => Assert.Equal(104 * 3, p.Thumbnail.Count));
        Assert.Contains(presets, p => p.NeedsKeys);
    }

    [Fact]
    public void CopyOfABuiltInEffectMatchesItsId()
    {
        var presets = PresetCatalog.Load(PresetsDir);
        var tmp = Path.Combine(Path.GetTempPath(), $"rgbp-preset-{Guid.NewGuid():N}.lep");
        try
        {
            File.Copy(presets[1].FilePath!, tmp);
            Assert.Equal("cyber-rain", PresetCatalog.MatchBundled(tmp, presets));
            File.WriteAllBytes(tmp, new byte[] { 1, 2, 3 });
            Assert.Null(PresetCatalog.MatchBundled(tmp, presets));
        }
        finally
        {
            File.Delete(tmp);
        }
    }

    [Fact]
    public void MissingDirectoryGivesEmptyList()
    {
        Assert.Empty(PresetCatalog.Load(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))));
    }

    [Fact]
    public void WordingMatchesMac()
    {
        Assert.Equal("预设灯效", PresetStrings.Title("zh"));
        Assert.Equal("Presets", PresetStrings.Title("en"));
        Assert.Equal("内置灯效", PresetStrings.SourcePreset("zh"));
        Assert.Equal("Built-in effect", PresetStrings.SourcePreset("en"));
    }
}
