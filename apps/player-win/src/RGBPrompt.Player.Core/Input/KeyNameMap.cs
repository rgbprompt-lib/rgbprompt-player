namespace RGBPrompt.Player.Core.Input;

/// <summary>
/// Maps Windows virtual-key codes to ANSI-104 names used by the engine
/// (PLAYER §5.2 / PLW-05). Extended keys that share a VK with a numpad key
/// are resolved by the low-level hook via the EF0 / EF1 extended flags before
/// calling <see cref="Name"/>.
/// </summary>
public static class KeyNameMap
{
    static readonly Dictionary<int, string> NamesByVk = new()
    {
        [0x1B] = "ESC",
        [0x70] = "F1", [0x71] = "F2", [0x72] = "F3", [0x73] = "F4",
        [0x74] = "F5", [0x75] = "F6", [0x76] = "F7", [0x77] = "F8",
        [0x78] = "F9", [0x79] = "F10", [0x7A] = "F11", [0x7B] = "F12",
        [0x2C] = "PRINTSCREEN", [0x91] = "SCROLLLOCK", [0x13] = "PAUSE",

        [0xC0] = "GRAVE",
        [0x31] = "1", [0x32] = "2", [0x33] = "3", [0x34] = "4", [0x35] = "5",
        [0x36] = "6", [0x37] = "7", [0x38] = "8", [0x39] = "9", [0x30] = "0",
        [0xBD] = "MINUS", [0xBB] = "EQUAL", [0x08] = "BACKSPACE",
        [0x2D] = "INSERT", [0x24] = "HOME", [0x21] = "PAGEUP",
        [0x90] = "NUMLOCK", [0x6F] = "KP_SLASH", [0x6A] = "KP_ASTERISK", [0x6D] = "KP_MINUS",

        [0x09] = "TAB",
        [0x51] = "Q", [0x57] = "W", [0x45] = "E", [0x52] = "R", [0x54] = "T",
        [0x59] = "Y", [0x55] = "U", [0x49] = "I", [0x4F] = "O", [0x50] = "P",
        [0xDB] = "LBRACKET", [0xDD] = "RBRACKET", [0xDC] = "BACKSLASH",
        [0x2E] = "DELETE", [0x23] = "END", [0x22] = "PAGEDOWN",
        [0x67] = "KP_7", [0x68] = "KP_8", [0x69] = "KP_9", [0x6B] = "KP_PLUS",

        [0x14] = "CAPSLOCK",
        [0x41] = "A", [0x53] = "S", [0x44] = "D", [0x46] = "F", [0x47] = "G",
        [0x48] = "H", [0x4A] = "J", [0x4B] = "K", [0x4C] = "L",
        [0xBA] = "SEMICOLON", [0xDE] = "QUOTE", [0x0D] = "ENTER",
        [0x64] = "KP_4", [0x65] = "KP_5", [0x66] = "KP_6",

        [0xA0] = "LSHIFT", [0x10] = "LSHIFT",
        [0x5A] = "Z", [0x58] = "X", [0x43] = "C", [0x56] = "V", [0x42] = "B",
        [0x4E] = "N", [0x4D] = "M",
        [0xBC] = "COMMA", [0xBE] = "PERIOD", [0xBF] = "SLASH", [0xA1] = "RSHIFT",
        [0x26] = "UP",
        [0x61] = "KP_1", [0x62] = "KP_2", [0x63] = "KP_3", [0x0D] = "ENTER", // KP_ENTER handled as extended

        [0xA2] = "LCTRL", [0x11] = "LCTRL", [0x5B] = "LGUI", [0xA4] = "LALT", [0x12] = "LALT",
        [0x20] = "SPACE",
        [0xA5] = "RALT", [0x5C] = "RGUI", [0x5D] = "APPLICATION", [0xA3] = "RCTRL",
        [0x25] = "LEFT", [0x28] = "DOWN", [0x27] = "RIGHT",
        [0x60] = "KP_0", [0x6E] = "KP_PERIOD",
    };

    /// <summary>Extended-key overrides (bit 24 of lParam / LLKHF_EXTENDED).</summary>
    static readonly Dictionary<int, string> ExtendedOverrides = new()
    {
        [0x0D] = "KP_ENTER", // when extended; non-extended ENTER stays ENTER via NamesByVk
        [0x11] = "RCTRL",
        [0x12] = "RALT",
        [0x21] = "PAGEUP",
        [0x22] = "PAGEDOWN",
        [0x23] = "END",
        [0x24] = "HOME",
        [0x25] = "LEFT",
        [0x26] = "UP",
        [0x27] = "RIGHT",
        [0x28] = "DOWN",
        [0x2D] = "INSERT",
        [0x2E] = "DELETE",
        [0x5B] = "LGUI",
        [0x5C] = "RGUI",
        [0x5D] = "APPLICATION",
    };

    public static string? Name(int virtualKey, bool extended = false)
    {
        if (extended && ExtendedOverrides.TryGetValue(virtualKey, out var ext))
            return ext;
        // Non-extended ENTER must not become KP_ENTER.
        if (!extended && virtualKey == 0x0D) return "ENTER";
        return NamesByVk.TryGetValue(virtualKey, out var name) ? name : null;
    }

    public static IReadOnlyCollection<string> AllNames { get; } =
        new HashSet<string>(NamesByVk.Values.Concat(ExtendedOverrides.Values));
}
