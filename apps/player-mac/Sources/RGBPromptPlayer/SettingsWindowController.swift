import AppKit
import Combine
import PlayerKit
import SwiftUI

/// One non-resizable 400 × 560 settings window (PLY-15). Reopening brings the
/// same window forward.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let language: LanguageStore
    private let activation: ActivationPolicyCoordinator
    private let window: NSWindow
    private var cancellables = Set<AnyCancellable>()
    private var presented = false

    init(
        bridge: PlayerCoreBridge,
        model: SettingsModel,
        language: LanguageStore,
        login: LoginItemModel,
        activation: ActivationPolicyCoordinator,
        actions: SettingsViewActions
    ) {
        self.language = language
        self.activation = activation

        let root = SettingsRootView(
            bridge: bridge,
            model: model,
            language: language,
            login: login,
            actions: actions
        )
        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(x: 0, y: 0, width: 400, height: 560)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 560),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = L10n.tr("settings.title")
        window.contentView = hosting
        window.isReleasedWhenClosed = false
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 400, height: 560)
        window.maxSize = NSSize(width: 400, height: 560)
        window.center()

        super.init()
        window.delegate = self

        language.$effective
            .removeDuplicates()
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.window.title = L10n.tr("settings.title")
                }
            }
            .store(in: &cancellables)
    }

    func show() {
        if !presented {
            presented = true
            activation.acquire()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        dismiss()
    }

    private func dismiss() {
        if window.isVisible {
            window.orderOut(nil)
        }
        if presented {
            presented = false
            activation.release()
        }
    }

    func windowWillClose(_ notification: Notification) {
        dismiss()
    }
}
