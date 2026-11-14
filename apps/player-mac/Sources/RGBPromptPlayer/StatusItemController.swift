import AppKit
import Combine
import PlayerKit

@MainActor
final class StatusItemController {
    var onToggle: () -> Void = {}
    var onDropLep: (URL) -> Void = { _ in }

    var button: NSStatusBarButton? { statusItem.button }

    private let statusItem: NSStatusItem
    private let bridge: PlayerCoreBridge
    private let language: LanguageStore
    private var cancellables = Set<AnyCancellable>()

    init(bridge: PlayerCoreBridge, language: LanguageStore) {
        self.bridge = bridge
        self.language = language
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            button.target = self
            button.action = #selector(toggle)
            button.imagePosition = .imageOnly
            button.toolTip = L10n.tr("app.name")

            let drop = StatusDropView()
            drop.onDrop = { [weak self] url in self?.onDropLep(url) }
            drop.frame = button.bounds
            drop.autoresizingMask = [.width, .height]
            button.addSubview(drop)

            updateImage(for: bridge.state)
        }

        bridge.$state
            .sink { [weak self] state in
                Task { @MainActor in self?.updateImage(for: state) }
            }
            .store(in: &cancellables)

        language.$effective
            .removeDuplicates()
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.button?.toolTip = L10n.tr("app.name")
                    self?.updateImage(for: self?.bridge.state ?? .idle(failure: nil))
                }
            }
            .store(in: &cancellables)
    }

    @objc private func toggle() {
        onToggle()
    }

    private func updateImage(for state: PanelState) {
        button?.image = Self.makeImage(for: StatusBadge.from(state))
    }

    /// The brand keycap (`MenuBarIcon`, a template image). Without a badge it
    /// is returned as a template so macOS tints it like every other menu-bar
    /// icon; with a badge the glyph is tinted by hand so the coloured dot keeps
    /// its colour.
    private static func makeImage(for badge: StatusBadge) -> NSImage {
        let glyph = NSImage(named: "MenuBarIcon") ?? NSImage()
        let size = NSSize(width: 20, height: 18)
        let glyphRect = NSRect(x: 1, y: 1, width: 16, height: 16)

        if badge == .none {
            let image = NSImage(size: size, flipped: false) { _ in
                glyph.draw(in: glyphRect)
                return true
            }
            image.isTemplate = true
            image.accessibilityDescription = L10n.tr("app.name")
            return image
        }

        let image = NSImage(size: size, flipped: false) { bounds in
            let tinted = NSImage(size: bounds.size, flipped: false) { _ in
                glyph.draw(in: glyphRect)
                NSColor.labelColor.set()
                bounds.fill(using: .sourceAtop)
                return true
            }
            tinted.draw(in: bounds)
            let dot = badge == .playing ? NSColor.systemGreen : NSColor.systemOrange
            dot.setFill()
            NSBezierPath(ovalIn: NSRect(x: 13.5, y: 0.5, width: 6, height: 6)).fill()
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = L10n.tr("app.name")
        return image
    }
}

private final class StatusDropView: NSView {
    var onDrop: ((URL) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        (superview as? NSStatusBarButton)?.performClick(nil)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard Self.lepURL(in: sender) != nil else { return [] }
        (superview as? NSStatusBarButton)?.highlight(true)
        return .copy
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        (superview as? NSStatusBarButton)?.highlight(false)
    }

    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        (superview as? NSStatusBarButton)?.highlight(false)
    }

    private static func lepURL(in sender: NSDraggingInfo) -> URL? {
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [NSURL] ?? []
        return urls.map { $0 as URL }.first { $0.pathExtension.lowercased() == "lep" }
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [NSURL] ?? []
        guard let url = urls
            .map({ $0 as URL })
            .first(where: { $0.pathExtension.lowercased() == "lep" }) else {
            return false
        }
        onDrop?(url)
        return true
    }
}
