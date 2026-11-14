namespace RGBPrompt.Player.Core.Input;

/// <summary>
/// Bits returned by <c>rgbp_input_wanted</c>. Must match the Rust core
/// (<c>engine_host::input_wanted</c>): audio = 1, keys = 2.
/// </summary>
[Flags]
public enum InputWants : uint
{
    None = 0,
    Audio = 1,
    Keys = 2,
}
