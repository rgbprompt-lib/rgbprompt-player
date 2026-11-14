import Combine
import Foundation

/// Pulls `rgbp_preview_frame` at most 25 times a second while the panel is
/// visible and the core is playing. Only a changed sequence number is published.
@MainActor
public final class PreviewPoller: ObservableObject {
    @Published public private(set) var frame: PreviewFrame?

    public let interval: Duration

    private let bridge: PlayerCoreBridge
    private var task: Task<Void, Never>?

    public init(bridge: PlayerCoreBridge, interval: Duration = .milliseconds(40)) {
        self.bridge = bridge
        self.interval = interval
    }

    public var isRunning: Bool {
        task != nil
    }

    public func setActive(_ active: Bool) {
        if active {
            guard task == nil else { return }
            task = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    guard let self else { return }
                    self.pollOnce()
                    try? await Task.sleep(for: self.interval)
                }
            }
        } else {
            task?.cancel()
            task = nil
        }
    }

    @discardableResult
    public func pollOnce() -> PreviewFrame? {
        guard let next = bridge.previewFrame() else { return nil }
        if next.seq != frame?.seq {
            frame = next
        }
        return next
    }
}
