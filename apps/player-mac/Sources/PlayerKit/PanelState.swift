import Foundation

public enum KeyboardSupport: Int32, Equatable, Sendable {
    case unknown = -1
    case perKey = 0
    case zones = 1
    case single = 2

    public var localizationKey: String {
        switch self {
        case .unknown: return "support.unknown"
        case .perKey: return "support.perKey"
        case .zones: return "support.zones"
        case .single: return "support.single"
        }
    }
}

public enum PanelState: Equatable, Sendable {
    case idle(failure: FailureCode?)
    case preparing
    case needsDriver(progress: Int?, driverError: Int32)
    case noKeyboard(deviceLost: Bool)
    case playing
    case backendUnresponsive
    case vendorConflict(name: String?)
    case blocked
    case coreUnavailable

    /// Maps the numeric C state (PLAYER §6) onto the shell state. Unknown
    /// numbers never crash; they become `coreUnavailable`.
    public static func from(_ event: CoreStateEvent) -> PanelState {
        switch event.state {
        case 0:
            let failure = event.error == 0 ? nil : (FailureCode(code: event.error) ?? .internalError)
            return .idle(failure: failure)
        case 1:
            return .preparing
        case 2:
            let progress = event.driverProgress >= 0 ? Int(min(max(event.driverProgress, 0), 100)) : nil
            return .needsDriver(progress: progress, driverError: event.driverError)
        case 3:
            return .noKeyboard(deviceLost: event.error == FailureCode.deviceLost.code)
        case 4:
            return .playing
        case 5:
            return .backendUnresponsive
        case 6:
            let name = event.conflictName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return .vendorConflict(name: name.isEmpty ? nil : name)
        case 7:
            return .blocked
        default:
            return .coreUnavailable
        }
    }

    public var isPlaying: Bool {
        if case .playing = self { return true }
        return false
    }

    public var headerStatusKey: String {
        switch self {
        case .playing, .idle: return "panel.status.connected"
        case .preparing: return "panel.status.preparing"
        case .needsDriver: return "panel.status.driverNeeded"
        case .noKeyboard: return "panel.status.noKeyboard"
        case .backendUnresponsive: return "panel.status.backendUnresponsive"
        case .vendorConflict: return "panel.status.vendorConflict"
        case .blocked: return "panel.status.blocked"
        case .coreUnavailable: return "panel.status.internalError"
        }
    }
}

public enum StatusBadge: Equatable, Sendable {
    case none
    case playing
    case attention

    public static func from(_ state: PanelState) -> StatusBadge {
        switch state {
        case .playing:
            return .playing
        case .needsDriver, .noKeyboard, .backendUnresponsive, .vendorConflict, .blocked, .coreUnavailable:
            return .attention
        case .idle(let failure):
            return failure == nil ? .none : .attention
        case .preparing:
            return .none
        }
    }
}
