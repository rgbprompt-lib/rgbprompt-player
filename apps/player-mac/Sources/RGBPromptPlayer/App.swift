import SwiftUI

@main
struct RGBPromptPlayerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        // The real settings window is an AppKit window owned by AppController
        // (400 × 560, non-resizable). ⌘, is handled by the panel footer row,
        // so the default Settings scene must not steal the shortcut.
        Settings {
            EmptyView()
        }
        .commands {
            CommandGroup(replacing: .appSettings) {}
        }
    }
}
