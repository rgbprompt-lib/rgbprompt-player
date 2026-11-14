import Carbon.HIToolbox
import CoreGraphics
import Foundation
import IOKit.hid
import os

public enum KeyAuth: Equatable, Sendable {
    case granted
    case denied
    case notDetermined
}

public protocol KeyCapturing: AnyObject {
    func authorization() -> KeyAuth
    func requestAuthorization()
    func start(onKey: @escaping (String, Bool) -> Void) -> Bool
    func stop()
}

/// Session-level, listen-only event tap. It needs Input Monitoring, not
/// Accessibility, and only reads key codes; names never reach a log.
public final class EventTapKeyCapture: KeyCapturing, @unchecked Sendable {
    private static let logger = Logger(subsystem: "com.rgbprompt.player", category: "input")

    nonisolated(unsafe) private var tap: CFMachPort?
    nonisolated(unsafe) private var source: CFRunLoopSource?
    nonisolated(unsafe) private var onKey: ((String, Bool) -> Void)?

    public init() {}

    deinit {
        stop()
    }

    public func authorization() -> KeyAuth {
        if CGPreflightListenEventAccess() {
            return .granted
        }
        return UserDefaults.standard.bool(forKey: InputSettings.keyInputExplained)
            ? .denied
            : .notDetermined
    }

    public func requestAuthorization() {
        // CGRequestListenEventAccess alone does not re-add the app once its
        // entry was removed from System Settings. Asking through IOHID and
        // probing a listen-only tap both make TCC list this bundle again.
        _ = CGRequestListenEventAccess()
        _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
        // Opening a keyboard through IOHID is what reliably makes macOS list
        // the app under Input Monitoring (the old prototype got listed this
        // way). The manager is closed right away; capture still uses the tap.
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        IOHIDManagerSetDeviceMatching(manager, [
            kIOHIDDeviceUsagePageKey as String: kHIDPage_GenericDesktop,
            kIOHIDDeviceUsageKey as String: kHIDUsage_GD_Keyboard,
        ] as CFDictionary)
        let opened = IOHIDManagerOpen(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        Self.logger.info("key_capture hid_open \(opened, privacy: .public)")
        IOHIDManagerClose(manager, IOOptionBits(kIOHIDOptionsTypeNone))
        if let probe = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(1) << CGEventType.keyDown.rawValue,
            callback: { _, _, event, _ in Unmanaged.passUnretained(event) },
            userInfo: nil
        ) {
            CFMachPortInvalidate(probe)
        }
    }

    public func start(onKey: @escaping (String, Bool) -> Void) -> Bool {
        if tap != nil {
            return true
        }

        let mask =
            (CGEventMask(1) << CGEventType.keyDown.rawValue)
            | (CGEventMask(1) << CGEventType.keyUp.rawValue)
            | (CGEventMask(1) << CGEventType.flagsChanged.rawValue)

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: Self.eventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            Self.logger.error("key_capture start failed")
            return false
        }

        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        self.tap = tap
        self.source = source
        self.onKey = onKey
        Self.logger.info("key_capture start")
        return true
    }

    public func stop() {
        guard tap != nil else { return }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        tap = nil
        source = nil
        onKey = nil
        Self.logger.info("key_capture stop")
    }

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
        guard let userInfo else {
            return Unmanaged.passUnretained(event)
        }
        let capture = Unmanaged<EventTapKeyCapture>.fromOpaque(userInfo).takeUnretainedValue()
        capture.handle(type: type, event: event)
        return Unmanaged.passUnretained(event)
    }

    private func handle(type: CGEventType, event: CGEvent) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap {
                CGEvent.tapEnable(tap: tap, enable: true)
            }
            return
        default:
            break
        }

        let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))

        switch type {
        case .keyDown:
            guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else { return }
            guard let name = KeyNameMap.name(for: keyCode) else { return }
            onKey?(name, true)
        case .keyUp:
            guard let name = KeyNameMap.name(for: keyCode) else { return }
            onKey?(name, false)
        case .flagsChanged:
            if keyCode == UInt16(kVK_CapsLock) {
                // Caps Lock sends one flagsChanged per press, not a key pair.
                onKey?("CAPSLOCK", true)
                onKey?("CAPSLOCK", false)
                return
            }
            guard let name = KeyNameMap.name(for: keyCode),
                  let down = ModifierDecoder.isDown(
                      keyCode: keyCode,
                      flags: event.flags.rawValue
                  ) else {
                return
            }
            onKey?(name, down)
        default:
            return
        }
    }
}
