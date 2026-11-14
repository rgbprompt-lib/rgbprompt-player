import Foundation
import IOKit
import IOKit.hid
import os

/// USB keyboard hot-plug notifications (PLAYER §9.1, PLY-08). The IOKit
/// matching notifications do not open devices, so they need no Input
/// Monitoring permission (unlike `IOHIDManagerOpen`).
public protocol DeviceChangeWatching: AnyObject {
    /// Called on the main queue after a coalesced change.
    var onDevicesChanged: (() -> Void)? { get set }
    func start()
    func stop()
}

/// Collapses bursts of IOKit callbacks into one notification after `delay`.
public final class DeviceChangeCoalescer: @unchecked Sendable {
    public var onFlush: ((_ added: Int, _ removed: Int) -> Void)?

    private let delay: TimeInterval
    private let schedule: (TimeInterval, @escaping @Sendable () -> Void) -> Void
    private let lock = NSLock()
    private var scheduled = false
    private var added = 0
    private var removed = 0

    public init(
        delay: TimeInterval = 0.3,
        schedule: ((TimeInterval, @escaping @Sendable () -> Void) -> Void)? = nil
    ) {
        self.delay = delay
        self.schedule = schedule ?? { delay, action in
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: action)
        }
    }

    public func record(added: Int, removed: Int) {
        lock.lock()
        self.added += added
        self.removed += removed
        let shouldSchedule = !scheduled
        scheduled = true
        lock.unlock()

        guard shouldSchedule else { return }
        schedule(delay) { [weak self] in
            self?.flush()
        }
    }

    private func flush() {
        lock.lock()
        scheduled = false
        let added = self.added
        let removed = self.removed
        self.added = 0
        self.removed = 0
        lock.unlock()
        onFlush?(added, removed)
    }
}

public final class IOKitDeviceChangeWatcher: DeviceChangeWatching, @unchecked Sendable {
    public var onDevicesChanged: (() -> Void)?

    private let logger = Logger(subsystem: "com.rgbprompt.player", category: "hid")
    private let queue = DispatchQueue(label: "com.rgbprompt.player.hid")
    private let coalescer: DeviceChangeCoalescer
    private var notifyPort: IONotificationPortRef?
    private var iterators: [io_iterator_t] = []

    public init(coalescer: DeviceChangeCoalescer = DeviceChangeCoalescer()) {
        self.coalescer = coalescer
        coalescer.onFlush = { [weak self] added, removed in
            guard let self else { return }
            self.logger.info(
                "hid_change added=\(added, privacy: .public) removed=\(removed, privacy: .public)"
            )
            self.onDevicesChanged?()
        }
    }

    deinit {
        stop()
    }

    public func start() {
        guard notifyPort == nil, let port = IONotificationPortCreate(kIOMainPortDefault) else {
            return
        }
        IONotificationPortSetDispatchQueue(port, queue)

        let keyboard = Self.matching(usagePage: 1, usage: 6, transport: nil)
        let usb = Self.matching(usagePage: nil, usage: nil, transport: "USB")
        let refcon = Unmanaged.passUnretained(self).toOpaque()

        var created: [io_iterator_t] = []
        for (type, matching, callback) in [
            (kIOFirstMatchNotification, keyboard, Self.addedCallback),
            (kIOTerminatedNotification, keyboard, Self.removedCallback),
            (kIOFirstMatchNotification, usb, Self.addedCallback),
            (kIOTerminatedNotification, usb, Self.removedCallback),
        ] {
            guard let matching else { continue }
            var iterator: io_iterator_t = 0
            // IOServiceAddMatchingNotification consumes one reference to the
            // matching dictionary, and each dictionary is registered twice;
            // hand it a retained reference so ARC's own release stays balanced.
            let consumed = Unmanaged.passRetained(matching as CFDictionary)
            let result = IOServiceAddMatchingNotification(
                port,
                type,
                consumed.takeUnretainedValue(),
                callback,
                refcon,
                &iterator
            )
            guard result == KERN_SUCCESS, iterator != 0 else { continue }
            // First-match iterators deliver the devices that already exist;
            // drain them so launch does not notify.
            _ = Self.drain(iterator)
            created.append(iterator)
        }

        notifyPort = port
        iterators = created
    }

    public func stop() {
        if let notifyPort {
            IONotificationPortDestroy(notifyPort)
            self.notifyPort = nil
        }
        for iterator in iterators {
            IOObjectRelease(iterator)
        }
        iterators.removeAll()
    }

    private static let addedCallback: IOServiceMatchingCallback = { refcon, iterator in
        guard let refcon else { return }
        let watcher = Unmanaged<IOKitDeviceChangeWatcher>
            .fromOpaque(refcon)
            .takeUnretainedValue()
        watcher.coalescer.record(added: drain(iterator), removed: 0)
    }

    private static let removedCallback: IOServiceMatchingCallback = { refcon, iterator in
        guard let refcon else { return }
        let watcher = Unmanaged<IOKitDeviceChangeWatcher>
            .fromOpaque(refcon)
            .takeUnretainedValue()
        watcher.coalescer.record(added: 0, removed: drain(iterator))
    }

    private static func matching(
        usagePage: Int?,
        usage: Int?,
        transport: String?
    ) -> NSMutableDictionary? {
        guard let matching = IOServiceMatching(kIOHIDDeviceKey) else { return nil }
        let dictionary = matching as NSMutableDictionary
        if let usagePage {
            dictionary[kIOHIDPrimaryUsagePageKey] = usagePage
        }
        if let usage {
            dictionary[kIOHIDPrimaryUsageKey] = usage
        }
        if let transport {
            dictionary[kIOHIDTransportKey] = transport
        }
        return dictionary
    }

    private static func drain(_ iterator: io_iterator_t) -> Int {
        var count = 0
        var service = IOIteratorNext(iterator)
        while service != 0 {
            IOObjectRelease(service)
            count += 1
            service = IOIteratorNext(iterator)
        }
        return count
    }
}
