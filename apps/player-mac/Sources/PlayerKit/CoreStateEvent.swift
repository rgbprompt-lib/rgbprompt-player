import Foundation
import RGBPromptPlayerCore

/// A Swift copy of `RgbpStateEvent`. The C strings are valid only during the
/// callback, so everything is copied before the value leaves the control thread.
public struct CoreStateEvent: Equatable, Sendable {
    public var state: Int32
    public var error: Int32
    public var effectName: String
    public var keyboardName: String
    public var keyboardSupport: Int32
    public var fps: UInt32
    public var driverProgress: Int32
    public var driverError: Int32
    public var conflictName: String?

    public init(
        state: Int32,
        error: Int32 = 0,
        effectName: String = "",
        keyboardName: String = "",
        keyboardSupport: Int32 = -1,
        fps: UInt32 = 0,
        driverProgress: Int32 = -1,
        driverError: Int32 = 0,
        conflictName: String? = nil
    ) {
        self.state = state
        self.error = error
        self.effectName = effectName
        self.keyboardName = keyboardName
        self.keyboardSupport = keyboardSupport
        self.fps = fps
        self.driverProgress = driverProgress
        self.driverError = driverError
        self.conflictName = conflictName
    }

    public init(copying event: UnsafePointer<RgbpStateEvent>) {
        let value = event.pointee
        self.init(
            state: value.state,
            error: value.error,
            effectName: value.effect_name.map { String(cString: $0) } ?? "",
            keyboardName: value.keyboard_name.map { String(cString: $0) } ?? "",
            keyboardSupport: value.keyboard_support,
            fps: value.fps,
            driverProgress: value.driver_progress,
            driverError: value.driver_error,
            conflictName: value.conflict_name.map { String(cString: $0) }
        )
    }
}
