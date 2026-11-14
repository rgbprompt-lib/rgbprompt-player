import PlayerKit
import ServiceManagement

/// The only code that talks to `SMAppService` (PLY-20). Instantiated by
/// `AppController` in the app target; tests use a fake controller.
final class SMAppServiceLoginItem: LoginItemControlling {
    private let service = SMAppService.mainApp

    var status: LoginItemStatus {
        switch service.status {
        case .enabled:
            return .enabled
        case .requiresApproval:
            return .requiresApproval
        case .notRegistered:
            return .notRegistered
        case .notFound:
            return .notFound
        @unknown default:
            return .notFound
        }
    }

    func register() throws {
        try service.register()
    }

    func unregister() throws {
        try service.unregister()
    }

    func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
