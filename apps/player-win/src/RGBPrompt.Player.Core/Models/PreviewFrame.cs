namespace RGBPrompt.Player.Core.Models;

/// <summary>
/// One engine-rendered 104-key RGB frame from <c>rgbp_preview_frame</c>
/// (312 bytes, same order as <c>ANSI104_KEYS</c>).
/// </summary>
public readonly record struct PreviewFrame(long Seq, byte[] Rgb);
