import Carbon.HIToolbox
import XCTest
@testable import PlayerKit

final class ModifierDecoderTests: XCTestCase {
    private let modifiers: [(Int, UInt64)] = [
        (kVK_Control, ModifierDecoder.leftControl),
        (kVK_RightControl, ModifierDecoder.rightControl),
        (kVK_Shift, ModifierDecoder.leftShift),
        (kVK_RightShift, ModifierDecoder.rightShift),
        (kVK_Command, ModifierDecoder.leftCommand),
        (kVK_RightCommand, ModifierDecoder.rightCommand),
        (kVK_Option, ModifierDecoder.leftOption),
        (kVK_RightOption, ModifierDecoder.rightOption),
    ]

    func testEachModifierDownAndUp() {
        for (code, mask) in modifiers {
            XCTAssertEqual(
                ModifierDecoder.isDown(keyCode: UInt16(code), flags: mask),
                true,
                "key code \(code) down"
            )
            XCTAssertEqual(
                ModifierDecoder.isDown(keyCode: UInt16(code), flags: 0),
                false,
                "key code \(code) up"
            )
        }
    }

    func testLeftDownWhileRightIsHeld() {
        let flags = ModifierDecoder.leftControl | ModifierDecoder.rightControl
        XCTAssertEqual(ModifierDecoder.isDown(keyCode: UInt16(kVK_Control), flags: flags), true)
        XCTAssertEqual(
            ModifierDecoder.isDown(keyCode: UInt16(kVK_RightControl), flags: flags),
            true
        )
    }

    func testNonModifierIsNil() {
        XCTAssertNil(ModifierDecoder.isDown(keyCode: UInt16(kVK_ANSI_A), flags: 0))
        XCTAssertNil(
            ModifierDecoder.isDown(
                keyCode: UInt16(kVK_CapsLock),
                flags: ModifierDecoder.leftControl
            )
        )
    }
}
