import Foundation

/// The supervision block from `driverInfo()` (PLAYER §4). It tells the shell
/// whether Player is restarting its own driver or waiting for the user's
/// OpenRGB to come back.
public struct DriverSupervision: Codable, Equatable, Sendable {
    public let state: String?
    public let crashes: Int?
    public let crashLimit: Int?
    public let external: Bool?

    public init(
        state: String? = nil,
        crashes: Int? = nil,
        crashLimit: Int? = nil,
        external: Bool? = nil
    ) {
        self.state = state
        self.crashes = crashes
        self.crashLimit = crashLimit
        self.external = external
    }

    public var kind: SupervisionState {
        SupervisionState(rawValue: state ?? "") ?? .none
    }
}

public enum SupervisionState: String, Equatable, Sendable {
    case none
    case running
    case restarting
    case gaveUp
    case externalLost
}

/// The JSON written by `rgbp_driver_info_json` (PLAYER §9.0.2). Fields stay
/// optional so a newer core can add data without breaking the shell.
public struct DriverInfo: Codable, Equatable, Sendable {
    public let variant: String?
    public let version: String?
    public let sizeBytes: Int?
    public let installDir: String?
    public let source: String?
    public let license: String?
    public let installed: Bool?
    public let mode: String?
    public let port: Int?
    public let executable: String?
    public let verified: Bool?
    public let supervision: DriverSupervision?

    public init(
        variant: String? = nil,
        version: String? = nil,
        sizeBytes: Int? = nil,
        installDir: String? = nil,
        source: String? = nil,
        license: String? = nil,
        installed: Bool? = nil,
        mode: String? = nil,
        port: Int? = nil,
        executable: String? = nil,
        verified: Bool? = nil,
        supervision: DriverSupervision? = nil
    ) {
        self.variant = variant
        self.version = version
        self.sizeBytes = sizeBytes
        self.installDir = installDir
        self.source = source
        self.license = license
        self.installed = installed
        self.mode = mode
        self.port = port
        self.executable = executable
        self.verified = verified
        self.supervision = supervision
    }

    /// Anything other than an explicit `true` is treated as unverified.
    public var isVerified: Bool { verified == true }
}
