import Foundation

/// Pure path helpers for the Gatekeeper guide (PLAYER §4, PLY-16).
public enum DriverPaths {
    /// `…/standard-1.0/OpenRGB.app/Contents/MacOS/OpenRGB` → `…/standard-1.0/OpenRGB.app`.
    public static func appBundle(fromExecutable path: String) -> String? {
        var parts: [Substring] = []
        for component in path.split(separator: "/", omittingEmptySubsequences: false) {
            parts.append(component)
            if component.lowercased().hasSuffix(".app") {
                return parts.joined(separator: "/")
            }
        }
        return nil
    }

    /// Replaces the home directory prefix with `~` for display.
    public static func abbreviateHome(_ path: String, home: String = NSHomeDirectory()) -> String {
        if path == home {
            return "~"
        }
        let prefix = home.hasSuffix("/") ? home : home + "/"
        if path.hasPrefix(prefix) {
            return "~/" + path.dropFirst(prefix.count)
        }
        return path
    }
}


/// Locations the Mac shell treats as "OpenRGB is already on this machine"
/// (PLAYER §4 external path / M6-M2 reviewer note). Core resolve prefers a
/// live SDK server, then a managed install under `~/.rgbprompt/openrgb`; it
/// never looks in `/Applications`. Settings still needs to know the app is
/// present so it does not show "Not installed" when the user already has
/// OpenRGB (official or the side-by-side RGBPrompt build).
public enum DriverPresence {
    public static func candidateApps(home: URL = URL(fileURLWithPath: NSHomeDirectory())) -> [URL] {
        let rgb = home.appendingPathComponent(".rgbprompt", isDirectory: true)
        return [
            URL(fileURLWithPath: "/Applications/OpenRGB.app", isDirectory: true),
            home.appendingPathComponent("Applications/OpenRGB.app", isDirectory: true),
            rgb.appendingPathComponent("OpenRGB.app", isDirectory: true),
            rgb.appendingPathComponent("OpenRGB-RGBPrompt.app", isDirectory: true),
        ]
    }

    /// True when an OpenRGB `.app` with an executable binary exists at a known path.
    public static func isPresent(
        home: URL = URL(fileURLWithPath: NSHomeDirectory()),
        fileManager: FileManager = .default
    ) -> Bool {
        firstPresentApp(home: home, fileManager: fileManager) != nil
    }

    public static func firstPresentApp(
        home: URL = URL(fileURLWithPath: NSHomeDirectory()),
        fileManager: FileManager = .default
    ) -> URL? {
        for app in candidateApps(home: home) {
            let exe = app
                .appendingPathComponent("Contents", isDirectory: true)
                .appendingPathComponent("MacOS", isDirectory: true)
                .appendingPathComponent("OpenRGB", isDirectory: false)
            if fileManager.isExecutableFile(atPath: exe.path) {
                return app
            }
        }
        return nil
    }

    /// Short version from Info.plist when readable; otherwise nil.
    public static func shortVersion(of app: URL) -> String? {
        let plist = app
            .appendingPathComponent("Contents", isDirectory: true)
            .appendingPathComponent("Info.plist", isDirectory: false)
        guard
            let dict = NSDictionary(contentsOf: plist) as? [String: Any],
            let version = dict["CFBundleShortVersionString"] as? String,
            !version.isEmpty
        else {
            return nil
        }
        return version
    }
}
