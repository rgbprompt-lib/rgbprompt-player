import Combine
import Foundation

public enum LoginItemStatus: Equatable, Sendable {
    case enabled
    case requiresApproval
    case notRegistered
    case notFound
}

/// The only surface the model needs from `SMAppService`. The real
/// implementation lives in the app target and is never instantiated by tests.
public protocol LoginItemControlling: AnyObject {
    var status: LoginItemStatus { get }
    func register() throws
    func unregister() throws
    func openSystemSettings()
}

/// Pure switch logic for "Launch at login" (PLY-20). Default is off; the shell
/// never registers automatically.
@MainActor
public final class LoginItemModel: ObservableObject {
    public static let errorKey = "settings.login.error"

    @Published public private(set) var status: LoginItemStatus
    @Published public private(set) var errorKey: String?

    private let controller: any LoginItemControlling
    private let isInApplications: Bool

    /// `isInApplications`: whether the bundle lives under an Applications
    /// folder. `SMAppService.mainApp` can report `.notFound` before the first
    /// registration even for an installed app, so `.notFound` only blocks the
    /// switch when the app runs from somewhere else (a DMG, Downloads, a build).
    public init(controller: any LoginItemControlling, isInApplications: Bool = true) {
        self.controller = controller
        self.isInApplications = isInApplications
        status = controller.status
    }

    public var isOn: Bool {
        status == .enabled || status == .requiresApproval
    }

    public var isToggleEnabled: Bool {
        !isNotFound
    }

    public var needsApproval: Bool {
        status == .requiresApproval
    }

    public var isNotFound: Bool {
        status == .notFound && !isInApplications
    }

    public static func isInApplicationsFolder(_ bundleURL: URL) -> Bool {
        let path = bundleURL.standardizedFileURL.path
        return path.hasPrefix("/Applications/")
            || path.hasPrefix(NSHomeDirectory() + "/Applications/")
    }

    /// Re-reads the system status, used every time the settings window opens.
    public func refresh() {
        status = controller.status
        if status == .enabled {
            errorKey = nil
        }
    }

    public func toggle(on: Bool) {
        errorKey = nil
        do {
            if on {
                try controller.register()
            } else {
                try controller.unregister()
            }
        } catch {
            errorKey = Self.errorKey
        }
        status = controller.status
    }

    public func openSystemSettings() {
        controller.openSystemSettings()
    }
}
