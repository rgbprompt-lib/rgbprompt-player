import Foundation

/// Every `RGBP_ERR_*` status code from the C ABI. Values are matched by number,
/// never by message text.
public enum FailureCode: Int32, CaseIterable, Sendable {
    case internalError = -1
    case updateRequired = -2
    case decodeFailed = -3
    case linkUnavailable = -4
    case driverDeclined = -5
    case openrgbUnreachable = -6
    case deviceLost = -7
    case unsupportedPackage = -8
    case invalidArgument = -100
    case bufferTooSmall = -101
    case notSupported = -102
    case badUrl = -103

    public init?(code: Int32) {
        self.init(rawValue: code)
    }

    public var code: Int32 { rawValue }

    public var localizationKey: String {
        switch self {
        case .internalError: return "failure.internal"
        case .updateRequired: return "failure.updateRequired"
        case .decodeFailed: return "failure.decodeFailed"
        case .linkUnavailable: return "failure.linkUnavailable"
        case .driverDeclined: return "failure.driverDeclined"
        case .openrgbUnreachable: return "failure.openrgbUnreachable"
        case .deviceLost: return "failure.deviceLost"
        case .unsupportedPackage: return "failure.unsupportedPackage"
        case .invalidArgument: return "failure.invalidArgument"
        case .bufferTooSmall: return "failure.bufferTooSmall"
        case .notSupported: return "failure.notSupported"
        case .badUrl: return "failure.badUrl"
        }
    }
}

/// A failed C ABI call. Unrecognised numeric codes stay numeric instead of
/// being turned into display text.
public enum BridgeError: Error, Equatable, Sendable {
    case coreUnavailable
    case failure(FailureCode)
    case unknown(Int32)

    public static func from(code: Int32) -> BridgeError? {
        if code == 0 { return nil }
        if let failure = FailureCode(code: code) { return .failure(failure) }
        return .unknown(code)
    }
}
