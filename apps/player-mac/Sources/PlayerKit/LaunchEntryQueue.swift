import Foundation

/// Holds protocol / file entry points that arrive before the app controller is
/// ready, then delivers each distinct entry once.
///
/// On a cold `rgbprompt://` launch, AppKit or SwiftUI may deliver the URL via
/// a GetURL Apple Event or `application(_:open:)` before
/// `applicationDidFinishLaunching` has created the controller. Dropping that
/// first URL means the site has to be clicked again once the app is already
/// running. This queue keeps the first deep link and deduplicates the same
/// URL if both argv and the open-URL callback deliver it.
public final class LaunchEntryQueue {
    private var pending: [EntryPoint] = []
    private var started = false
    private var lastDeliveredKey: String?
    private let deliver: (EntryPoint) -> Void

    public init(deliver: @escaping (EntryPoint) -> Void) {
        self.deliver = deliver
    }

    /// Accept a launch entry. Ignored entries are discarded. Before `start()`,
    /// entries are queued; after `start()`, they are delivered immediately
    /// unless they repeat the last delivered key.
    public func submit(_ entry: EntryPoint) {
        guard entry != .ignored, let key = Self.key(entry) else { return }
        if !started {
            if pending.contains(where: { Self.key($0) == key }) { return }
            pending.append(entry)
            return
        }
        emit(entry, key: key)
    }

    /// Mark the controller ready and flush queued entries in arrival order,
    /// skipping duplicates of a key already delivered.
    public func start() {
        guard !started else { return }
        started = true
        let queued = pending
        pending.removeAll()
        for entry in queued {
            guard let key = Self.key(entry) else { continue }
            emit(entry, key: key)
        }
    }

    public var hasStarted: Bool { started }
    public var pendingCount: Int { pending.count }

    public static func key(_ entry: EntryPoint) -> String? {
        switch entry {
        case .playerURL(let url):
            return "url:" + url.absoluteString
        case .lepFile(let url):
            return "lep:" + url.standardizedFileURL.path
        case .ignored:
            return nil
        }
    }

    private func emit(_ entry: EntryPoint, key: String) {
        if lastDeliveredKey == key { return }
        lastDeliveredKey = key
        deliver(entry)
    }
}
