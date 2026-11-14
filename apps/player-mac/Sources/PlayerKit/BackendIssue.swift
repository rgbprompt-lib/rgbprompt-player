import Foundation

/// The backend card variant (PLAYER §6). Supervision tells Player's own
/// restarts apart from the user's OpenRGB going away.
public enum BackendIssue: Equatable, Sendable {
    case restarting(attempt: Int, limit: Int)
    case gaveUp
    case externalLost(port: Int)
    case unresponsive

    public static func from(state: PanelState, driverInfo: DriverInfo?) -> BackendIssue? {
        guard case .backendUnresponsive = state else { return nil }
        switch driverInfo?.supervision?.kind {
        case .restarting:
            return .restarting(
                attempt: max(1, driverInfo?.supervision?.crashes ?? 1),
                limit: max(1, driverInfo?.supervision?.crashLimit ?? 3)
            )
        case .gaveUp:
            return .gaveUp
        case .externalLost:
            return .externalLost(port: driverInfo?.port ?? 6742)
        default:
            return .unresponsive
        }
    }

    public var headerStatusKey: String {
        switch self {
        case .restarting: return "panel.status.restartingDriver"
        case .externalLost: return "panel.status.openrgbNotRunning"
        case .gaveUp, .unresponsive: return "panel.status.backendUnresponsive"
        }
    }
}
