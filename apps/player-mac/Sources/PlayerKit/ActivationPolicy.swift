import Foundation

public enum ActivationPolicy: Equatable, Sendable {
    case regular
    case accessory
}

/// Reference-counts the windows that need a Dock / menu-bar presence (PLY-05).
/// The first acquire switches to `.regular`; only the last release switches
/// back, so closing the setup window never demotes the app while settings is
/// still open. The setter is injected so the counter is tested without AppKit.
public final class ActivationPolicyCoordinator {
    public typealias Setter = (ActivationPolicy) -> Void

    private let setter: Setter
    public private(set) var openCount = 0

    public init(setter: @escaping Setter) {
        self.setter = setter
    }

    public func acquire() {
        openCount += 1
        if openCount == 1 {
            setter(.regular)
        }
    }

    public func release() {
        guard openCount > 0 else { return }
        openCount -= 1
        if openCount == 0 {
            setter(.accessory)
        }
    }
}
