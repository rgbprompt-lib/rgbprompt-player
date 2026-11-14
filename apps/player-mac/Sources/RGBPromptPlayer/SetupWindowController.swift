import AppKit
import Combine
import PlayerKit
import SwiftUI

/// One non-resizable 400 × 560 setup window (PLAYER §4, PLY-06, PLY-16).
@MainActor
final class SetupWindowController: NSObject, NSWindowDelegate {
    private let model: SetupWindowModel
    private let language: LanguageStore
    private let activation: ActivationPolicyCoordinator
    private let window: NSWindow
    private var cancellables = Set<AnyCancellable>()
    private var presented = false

    init(
        bridge: PlayerCoreBridge,
        model: SetupWindowModel,
        language: LanguageStore,
        activation: ActivationPolicyCoordinator,
        actions: SetupViewActions
    ) {
        self.model = model
        self.language = language
        self.activation = activation

        let root = SetupRootView(
            bridge: bridge,
            model: model,
            language: language,
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
        window.title = L10n.tr("setup.title")
        window.contentView = hosting
        window.isReleasedWhenClosed = false
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 400, height: 560)
        window.maxSize = NSSize(width: 400, height: 560)
        window.center()

        super.init()
        window.delegate = self

        model.$isOpen
            .removeDuplicates()
            .sink { [weak self] open in
                MainActor.assumeIsolated {
                    self?.apply(open: open)
                }
            }
            .store(in: &cancellables)

        language.$effective
            .removeDuplicates()
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.window.title = L10n.tr("setup.title")
                }
            }
            .store(in: &cancellables)
    }

    func show() {
        model.show()
    }

    func close() {
        model.close()
    }

    private func apply(open: Bool) {
        if open {
            present()
        } else {
            dismiss()
        }
    }

    private func present() {
        if !presented {
            presented = true
            activation.acquire()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
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
        model.close()
    }
}
