import AppKit
import Combine
import os
import PlayerKit
import UniformTypeIdentifiers

/// Tracks whether this app owns `rgbprompt://` and `.lep`. The registration
/// APIs are only called from the app, never from tests or scripts.
@MainActor
final class DefaultHandlerCoordinator: ObservableObject {
    @Published private(set) var isDefaultForScheme = true
    @Published private(set) var isDefaultForLep = true

    private let bridge: PlayerCoreBridge
    private let logger = Logger(subsystem: "com.rgbprompt.player", category: "handler")

    var showsDefaultHandlerPrompt: Bool {
        !(isDefaultForScheme && isDefaultForLep)
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

        isDefaultForScheme = matchesThisApp(schemeApp)
        isDefaultForLep = matchesThisApp(lepApp)
        _ = bridge.setProtocolRegistered(isDefaultForScheme)
    }

    func makeDefault() {
        let appURL = Bundle.main.bundleURL
        NSWorkspace.shared.setDefaultApplication(
            at: appURL,
            toOpenURLsWithScheme: "rgbprompt"
        ) { [weak self] error in
            if let error {
                self?.logger.error("scheme handler: \(error.localizedDescription, privacy: .public)")
            }
            Task { @MainActor in self?.refresh() }
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
