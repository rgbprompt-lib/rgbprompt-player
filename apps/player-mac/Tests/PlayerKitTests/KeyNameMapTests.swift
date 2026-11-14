import Carbon.HIToolbox
import XCTest
@testable import PlayerKit

final class KeyNameMapTests: XCTestCase {
    func testCoversTheLayoutNamesExactly() {
        let values = Array(KeyNameMap.namesByKeyCode.values)
        XCTAssertEqual(KeyNameMap.namesByKeyCode.count, 104)
        XCTAssertEqual(values.count, 104)
        XCTAssertEqual(Set(values).count, 104, "duplicate key name")
        XCTAssertEqual(Set(values), Set(KeyLayout.keys.map(\.name)))
        XCTAssertEqual(KeyNameMap.names, Set(KeyLayout.keys.map(\.name)))
    }

    func testMacSpecificEntries() {
        let expected: [(Int, String)] = [
            (kVK_Delete, "BACKSPACE"),
            (kVK_ForwardDelete, "DELETE"),
            (kVK_Help, "INSERT"),
            (kVK_F13, "PRINTSCREEN"),
            (kVK_F14, "SCROLLLOCK"),
            (kVK_F15, "PAUSE"),
            (kVK_ANSI_KeypadClear, "NUMLOCK"),
            (kVK_Return, "ENTER"),
            (kVK_ANSI_KeypadEnter, "KP_ENTER"),
            (kVK_Command, "LGUI"),
            (kVK_RightCommand, "RGUI"),
            (kVK_Option, "LALT"),
            (kVK_RightOption, "RALT"),
            (kVK_Control, "LCTRL"),
            (kVK_RightControl, "RCTRL"),
            (kVK_Shift, "LSHIFT"),
            (kVK_RightShift, "RSHIFT"),
            (kVK_CapsLock, "CAPSLOCK"),
            (kVK_ContextualMenu, "APPLICATION"),
            (kVK_ANSI_A, "A"),
            (kVK_ANSI_1, "1"),
            (kVK_ANSI_Grave, "GRAVE"),
            (kVK_ANSI_Keypad0, "KP_0"),
            (kVK_UpArrow, "UP"),
            (kVK_ANSI_KeypadDecimal, "KP_PERIOD"),
        ]

        for (code, name) in expected {
            XCTAssertEqual(KeyNameMap.name(for: UInt16(code)), name, "key code \(code)")
        }
    }

    func testUnmappedCodesAreNil() {
        for code in [10, 63, 81, 106] {
            XCTAssertNil(KeyNameMap.name(for: UInt16(code)), "key code \(code)")
        }
    }
}
