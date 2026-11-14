import AppKit
import Combine
import PlayerKit
import SwiftUI

/// View state the controller also needs: Esc closes the picker before the panel.
@MainActor
final class PanelUIState: ObservableObject {
    @Published var pickerOpen = false
}

@MainActor
final class PanelController {
    var onVisibilityChange: ((Bool) -> Void)?
    var statusButtonProvider: (() -> NSStatusBarButton?)?

    var isVisible: Bool { panel.isVisible }

    private let panel: PanelWindow
    private let hosting: FirstMouseHostingView<PanelRootView>
    private var cancellables = Set<AnyCancellable>()
    // The panel never auto-hides (user decision): it closes only through its
    // close button, Esc, or a second click on the menu-bar icon. That also lets
    // a file be dragged onto it from Finder.
    private let ui: PanelUIState
    /// True while the controller itself moves the panel.
    private var placing = false

    init(
        bridge: PlayerCoreBridge,
        poller: PreviewPoller,
        handler: DefaultHandlerCoordinator,
        input: InputCoordinator,
        setup: SetupWindowModel,
        panelModel: PanelModel,
        language: LanguageStore,
        actions: PanelActions
    ) {
        let ui = PanelUIState()
        self.ui = ui
        let root = PanelRootView(
            bridge: bridge,
            poller: poller,
            handler: handler,
            input: input,
            setup: setup,
            panelModel: panelModel,
            language: language,
            ui: ui,
            actions: actions
        )
        hosting = FirstMouseHostingView(rootView: root)
        hosting.frame = NSRect(x: 0, y: 0, width: 340, height: 120)

        panel = PanelWindow(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 120),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.contentView = hosting
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        // Movable only through the header drag handle (`WindowDragArea`); the
        // panel stays borderless, so it can't be resized or zoomed.
        panel.isMovable = true
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.onCancel = { [weak self] in
            guard let self else { return }
            if self.ui.pickerOpen {
                self.ui.pickerOpen = false
            } else {
                self.hide()
            }
        }

        bridge.objectWillChange
            .merge(
                with: handler.objectWillChange,
                input.objectWillChange,
                panelModel.objectWillChange,
                language.objectWillChange,
                setup.objectWillChange,
                ui.objectWillChange
            )
            .sink { [weak self] in
                Task { @MainActor in self?.resizeToFit() }
            }
            .store(in: &cancellables)

        // Any move we did not make ourselves is the user dragging the header.
        NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            // Delivered synchronously so `placing` is still accurate.
            queue: nil
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.placing, self.panel.isVisible else { return }
                self.rememberPosition()
            }
        }
        NotificationCenter.default.addObserver(
            forName: WindowDragArea.didRequestReset,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.resetPosition() }
        }

        resizeToFit()
    }

    func toggle() {
        if panel.isVisible {
            hide()
            return
        }
        show()
    }

    func show() {
        resizeToFit()
        if !restoreSavedPosition() {
            position()
        }
        let wasVisible = panel.isVisible
        // Activate so the first click on a button acts instead of only focusing.
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        if !wasVisible {
            onVisibilityChange?(true)
        }
    }

    #if DEBUG
    func debugOpenPicker() {
        ui.pickerOpen = true
    }
    #endif

    func hide() {
        ui.pickerOpen = false
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        onVisibilityChange?(false)
    }

    private func resizeToFit() {
        hosting.layoutSubtreeIfNeeded()
        let fitting = hosting.fittingSize
        let height = max(80, ceil(fitting.height))
        let size = NSSize(width: 340, height: height)

        if panel.isVisible {
            let topLeft = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
            placing = true
            panel.setContentSize(size)
            placing = false
            placeTopLeft(topLeft)
        } else {
            panel.setContentSize(size)
        }
        hosting.frame = NSRect(origin: .zero, size: size)
    }

    // MARK: - User position

    private static let positionKey = "panel.topLeft"

    private func placeTopLeft(_ point: NSPoint) {
        placing = true
        panel.setFrameTopLeftPoint(point)
        placing = false
    }

    private func rememberPosition() {
        let topLeft = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
        UserDefaults.standard.set(NSStringFromPoint(topLeft), forKey: Self.positionKey)
    }

    /// Double-clicking the header puts the panel back under the menu-bar icon.
    private func resetPosition() {
        UserDefaults.standard.removeObject(forKey: Self.positionKey)
        position()
    }

    /// Places the panel where the user last dragged it, kept fully on a
    /// visible screen. Returns false when there is no saved position.
    private func restoreSavedPosition() -> Bool {
        guard let saved = UserDefaults.standard.string(forKey: Self.positionKey) else {
            return false
        }
        let topLeft = NSPointFromString(saved)
        let size = panel.frame.size
        let screen = NSScreen.screens.first(where: { $0.frame.contains(topLeft) })
            ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return false }
        let x = min(max(topLeft.x, visible.minX), visible.maxX - size.width)
        let top = min(max(topLeft.y, visible.minY + size.height), visible.maxY)
        placeTopLeft(NSPoint(x: x, y: top))
        return true
    }

    private func position() {
        guard
            let button = statusButtonProvider?(),
            let buttonWindow = button.window
        else { return }

        let buttonRect = buttonWindow.convertToScreen(
            button.convert(button.bounds, to: nil)
        )
        let size = panel.frame.size
        let screen = buttonWindow.screen ?? NSScreen.main
        var x = buttonRect.midX - size.width / 2
        var top = buttonRect.minY - size.height - 4

        if let visible = screen?.visibleFrame {
            x = min(max(x, visible.minX + 8), visible.maxX - size.width - 8)
            if top < visible.minY + 8 {
                top = buttonRect.maxY + 4
            }
        }
        placeTopLeft(NSPoint(x: x, y: top))
    }
}

/// The panel stays open while the user works in other apps, so the first click
/// on it must act (pick, stop, close) instead of only focusing the panel.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}

private final class PanelWindow: NSPanel {
    var onCancel: (() -> Void)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override var acceptsFirstResponder: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}

/// A transparent strip that drags its window. Borderless panels have no title
/// bar, so the header hands the mouse-down to `performDrag`.
struct WindowDragArea: NSViewRepresentable {
    static let didRequestReset = Notification.Name("RGBPromptPlayer.windowDragArea.didRequestReset")

    func makeNSView(context: Context) -> NSView {
        DragView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    private final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }

        override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
            true
        }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            if event.clickCount == 2 {
                NotificationCenter.default.post(name: WindowDragArea.didRequestReset, object: window)
                return
            }
            window.performDrag(with: event)
        }
    }
}
