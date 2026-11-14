import Carbon.HIToolbox

/// Reads the device-dependent modifier bits of a `flagsChanged` event. The
/// generic `.maskShift` / `.maskControl` bits cannot tell left from right, so
/// this uses the AppKit `NX_DEVICE*KEYMASK` bits that `CGEventFlags` carries.
public enum ModifierDecoder {
    public static let leftControl: UInt64 = 0x1
    public static let leftShift: UInt64 = 0x2
    public static let rightShift: UInt64 = 0x4
    public static let leftCommand: UInt64 = 0x8
    public static let rightCommand: UInt64 = 0x10
    public static let leftOption: UInt64 = 0x20
    public static let rightOption: UInt64 = 0x40
    public static let rightControl: UInt64 = 0x2000

    /// Returns whether the modifier for `keyCode` is down, or nil when the key
    /// code is not one of the eight side-specific modifiers.
    public static func isDown(keyCode: UInt16, flags: UInt64) -> Bool? {
        switch Int(keyCode) {
        case kVK_Control:
            return flags & leftControl != 0
        case kVK_RightControl:
            return flags & rightControl != 0
        case kVK_Shift:
            return flags & leftShift != 0
        case kVK_RightShift:
            return flags & rightShift != 0
        case kVK_Command:
            return flags & leftCommand != 0
        case kVK_RightCommand:
            return flags & rightCommand != 0
        case kVK_Option:
            return flags & leftOption != 0
        case kVK_RightOption:
            return flags & rightOption != 0
        default:
            return nil
        }
    }
}
