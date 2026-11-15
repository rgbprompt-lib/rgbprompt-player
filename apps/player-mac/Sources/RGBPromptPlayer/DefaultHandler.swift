import AppKit
import Combine
import os
import PlayerKit
import UniformTypeIdentifiers

/// Tracks whether this app owns `rgbprompt://` and `.lep`. The registration
/// APIs are only called from the app, never from tests or scripts.
///
/// The `rgbprompt` URL scheme is declared only on official signed packages
/// (`tools/player/sign-notarize-mac.sh` injects `CFBundleURLTypes` into the
/// staged app). Daily Xcode / Release builds omit it, so Launch Services will
/// not re-register a development copy, and "Make default" will not claim the
/// scheme unless the running bundle already declares it.
@MainActor
final class DefaultHandlerCoordinator: ObservableObject {
    @Published private(set) var isDefaultForScheme = true
    @Published private(set) var isDefaultForLep = true

    private let bridge: PlayerCoreBridge
    private let logger = Logger(subsystem: "com.rgbprompt.player", category: "handler")

    /// Official distribution packages declare `rgbprompt` in Info.plist;
    /// development builds do not.
    var declaresRgbpromptScheme: Bool {
        guard let types = Bundle.main.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]] else {
            return false
        }
        return types.contains { type in
            let schemes = type["CFBundleURLSchemes"] as? [String] ?? []
            return schemes.contains { $0.caseInsensitiveCompare("rgbprompt") == .orderedSame }
        }
    }

    var showsDefaultHandlerPrompt: Bool {
        if declaresRgbpromptScheme {
            return !(isDefaultForScheme && isDefaultForLep)
        }
        return !isDefaultForLep
    }

    private var lepType: UTType? {
        UTType("com.rgbprompt.lep") ?? UTType(filenameExtension: "lep", conformingTo: .data)
    }

    init(bridge: PlayerCoreBridge) {
        self.bridge = bridge
    }

    func refresh() {
        let scheme = URL(string: "rgbprompt://open")
        let schemeApp = scheme.flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0) }
        let lepApp = lepType.flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0) }

        isDefaultForScheme = declaresRgbpromptScheme && matchesThisApp(schemeApp)
        isDefaultForLep = matchesThisApp(lepApp)
        _ = bridge.setProtocolRegistered(isDefaultForScheme)
    }

    func makeDefault() {
        let appURL = Bundle.main.bundleURL
        // Never claim rgbprompt:// from a development build that does not
        // declare the scheme. Launch does not register it automatically.
        if declaresRgbpromptScheme {
            NSWorkspace.shared.setDefaultApplication(
                at: appURL,
                toOpenURLsWithScheme: "rgbprompt"
            ) { [weak self] error in
                if let error {
                    self?.logger.error("scheme handler: \(error.localizedDescription, privacy: .public)")
                }
                Task { @MainActor in self?.refresh() }
            }
        }

        if let lepType {
            NSWorkspace.shared.setDefaultApplication(
                at: appURL,
                toOpen: lepType
            ) { [weak self] error in
                if let error {
                    self?.logger.error("lep handler: \(error.localizedDescription, privacy: .public)")
                }
                Task { @MainActor in self?.refresh() }
            }
        }
    }

    private func matchesThisApp(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.standardizedFileURL == Bundle.main.bundleURL.standardizedFileURL
    }
}
