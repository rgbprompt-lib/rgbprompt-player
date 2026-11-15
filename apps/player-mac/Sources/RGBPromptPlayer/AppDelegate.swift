import AppKit
import PlayerKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: AppController?
    private lazy var launchQueue = LaunchEntryQueue { [weak self] entry in
        self?.controller?.open(entry)
    }

    override init() {
        super.init()
        // Register as early as possible. A cold rgbprompt:// launch can deliver
        // the GetURL Apple Event before applicationDidFinishLaunching (and
        // sometimes before application(_:open:)), and SwiftUI's adaptor does
        // not always forward that first event.
        Self.registerGetURLHandler(self)
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        Self.registerGetURLHandler(self)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let controller = AppController()
        self.controller = controller
        controller.didLaunch()

        if let entry = EntryPoint.fromLaunchArguments(CommandLine.arguments) {
            launchQueue.submit(entry)
        }
        launchQueue.start()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            launchQueue.submit(EntryPoint.classify(url))
        }
    }

    @objc
    func handleGetURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent replyEvent: NSAppleEventDescriptor) {
        let keyword = AEKeyword(0x2D2D2D2D) // keyDirectObject '----'
        guard let string = event.paramDescriptor(forKeyword: keyword)?.stringValue,
              let url = URL(string: string) else { return }
        launchQueue.submit(EntryPoint.classify(url))
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
    }

    private static func registerGetURLHandler(_ handler: AppDelegate) {
        NSAppleEventManager.shared().setEventHandler(
            handler,
            andSelector: #selector(handleGetURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(0x4755524C), // 'GURL'
            andEventID: AEEventID(0x4755524C) // 'GURL'
        )
    }
}
