import Combine
import Foundation

/// Remembers vendor-conflict names for the quit hint (PLAYER §8). Names arrive
/// already joined with ", " from the core; splitting them lets a later single
/// name deduplicate against the earlier combined event.
public struct VendorConflictSession: Equatable, Sendable {
    public private(set) var names: [String]

    public init(names: [String] = []) {
        self.names = names
    }

    public mutating func note(_ raw: String?) {
        guard let raw else { return }
        let parts = raw
            .components(separatedBy: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        for part in parts where !names.contains(part) {
            names.append(part)
        }
    }

    public var displayNames: String {
        names.joined(separator: ", ")
    }

    public var isEmpty: Bool {
        names.isEmpty
    }
}

/// Session-only panel state: the last keyboard name for the settings status
/// row and the vendor names seen while playing (for the quit hint).
@MainActor
public final class PanelModel: ObservableObject {
    @Published public private(set) var lastKeyboardName: String = ""
    @Published public private(set) var conflicts = VendorConflictSession()

    public init() {}

    public func apply(state: PanelState, keyboardName: String) {
        // Always mirror core: empty means "no keyboard detected right now".
        lastKeyboardName = keyboardName.trimmingCharacters(in: .whitespacesAndNewlines)
        if case .vendorConflict(let name) = state {
            conflicts.note(name)
        }
    }

    public var hasConflictHint: Bool {
        !conflicts.isEmpty
    }
}
