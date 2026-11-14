import AppKit
import PlayerKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: AppController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let controller = AppController()
        self.controller = controller
        controller.didLaunch()

        if let entry = EntryPoint.fromLaunchArguments(CommandLine.arguments) {
            controller.open(entry)
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            controller?.open(EntryPoint.classify(url))
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller?.shutdown()
    }
}
