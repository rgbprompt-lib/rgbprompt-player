import AppKit
import Foundation

@MainActor
public protocol DiagnosticsSource: AnyObject {
    func diagnosticsJSON() -> String?
}

extension PlayerCoreBridge: DiagnosticsSource {}

public protocol DiagnosticsPasteboard: AnyObject {
    @discardableResult
    func setString(_ value: String) -> Bool
}

public final class SystemDiagnosticsPasteboard: DiagnosticsPasteboard {
    public init() {}

    @discardableResult
    public func setString(_ value: String) -> Bool {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        return pasteboard.setString(value, forType: .string)
    }
}

/// One place for "copy diagnostics" (CLAUDE.md rule 6): the core JSON is copied
/// verbatim, only reformatted, and Swift never adds fields.
@MainActor
public struct DiagnosticsCopier {
    /// Exactly the keys `PlayerDiagnosticsSchema` allows. Used by tests to prove
    /// the Swift layer adds nothing.
    public static let allowedTopLevelKeys: Set<String> = [
        "schema",
        "playerVersion",
        "platform",
        "osVersion",
        "engineVersion",
        "openrgb",
        "protocolRegistered",
        "devices",
        "recentErrors",
    ]

    private let source: any DiagnosticsSource
    private let config: BridgeConfig
    private let protocolRegistered: Bool
    private let pasteboard: any DiagnosticsPasteboard

    public init(
        source: any DiagnosticsSource,
        config: BridgeConfig,
        protocolRegistered: Bool,
        pasteboard: any DiagnosticsPasteboard = SystemDiagnosticsPasteboard()
    ) {
        self.source = source
        self.config = config
        self.protocolRegistered = protocolRegistered
        self.pasteboard = pasteboard
    }

    @discardableResult
    public func copy() -> Bool {
        let text: String
        if let core = source.diagnosticsJSON(), !core.isEmpty {
            text = Self.prettyPrinted(json: core) ?? core
        } else {
            text = Self.fallbackJSON(
                playerVersion: config.appVersion,
                osVersion: config.osVersion,
                protocolRegistered: protocolRegistered
            )
        }
        return pasteboard.setString(text)
    }

    public static func fallbackJSON(
        playerVersion: String,
        osVersion: String,
        protocolRegistered: Bool
    ) -> String {
        let object: [String: Any] = [
            "schema": 1,
            "playerVersion": playerVersion,
            "platform": "macos",
            "osVersion": osVersion,
            "protocolRegistered": protocolRegistered,
        ]
        return prettyPrinted(object: object) ?? "{}"
    }

    public static func prettyPrinted(json: String) -> String? {
        guard
            let data = json.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data),
            let pretty = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys]
            )
        else {
            return nil
        }
        return String(decoding: pretty, as: UTF8.self)
    }

    private static func prettyPrinted(object: Any) -> String? {
        guard
            let pretty = try? JSONSerialization.data(
                withJSONObject: object,
                options: [.prettyPrinted, .sortedKeys]
            )
        else {
            return nil
        }
        return String(decoding: pretty, as: UTF8.self)
    }
}
