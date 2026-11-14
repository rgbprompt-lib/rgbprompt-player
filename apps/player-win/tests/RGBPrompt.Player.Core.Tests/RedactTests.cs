using RGBPrompt.Player.Core.Services;

namespace RGBPrompt.Player.Core.Tests;

public class RedactTests
{
    [Fact]
    public void TruncatesTokenQuery()
    {
        var redacted = Redact.PlayerUrl("rgbprompt://play?t=abcdef123456&v=1");
        Assert.Contains("t=abcdef…", redacted);
        Assert.DoesNotContain("123456", redacted);
    }
}
