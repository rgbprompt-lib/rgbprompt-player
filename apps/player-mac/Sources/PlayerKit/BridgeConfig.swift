import Foundation

public struct BridgeConfig: Equatable, Sendable {
    public let dataDir: String
    public let apiBase: String
    public let language: String
    public let appVersion: String
    public let osVersion: String
    public let openrgbAddr: String?

    public init(
        dataDir: String,
        apiBase: String,
        language: String,
        appVersion: String,
        osVersion: String,
        openrgbAddr: String?
    ) {
        self.dataDir = dataDir
        self.apiBase = apiBase
        self.language = language
        self.appVersion = appVersion
        self.osVersion = osVersion
        self.openrgbAddr = openrgbAddr
    }
}

/// Builds `RgbpConfig` inputs from the environment, `UserDefaults` and the
/// Info.plist. The override rules are documented in apps/player-mac/README.md.
public enum BridgeConfigBuilder {
    public static let productionAPIBase = "https://rgbprompt.com/api"

    public static func dataDirectory(home: URL) -> URL {
        home.appendingPathComponent(".rgbprompt", isDirectory: true)
    }

    public static func resolveAPIBase(
        environment: [String: String],
        defaults: String?,
        infoPlist: String?
    ) -> String {
        for candidate in [environment["RGBP_API_BASE"], defaults, infoPlist] {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return trimTrailingSlash(value)
            }
        }
        return productionAPIBase
    }

    public static func resolveOpenRGBAddr(
        environment: [String: String],
        defaults: String?
    ) -> String? {
        for candidate in [environment["RGBP_OPENRGB_ADDR"], defaults] {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return nil
    }

    public static func language(preferredLanguages: [String]) -> String {
        guard let first = preferredLanguages.first?.lowercased() else { return "en" }
        return first.hasPrefix("zh") ? "zh-CN" : "en"
    }

    public static func normalizeOSVersion(_ raw: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "(\\d+)\\.(\\d+)(?:\\.(\\d+))?") else {
            return "0.0.0"
        }
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        guard let match = regex.firstMatch(in: raw, range: range) else { return "0.0.0" }
        func group(_ index: Int) -> String? {
            guard index < match.numberOfRanges,
                  let range = Range(match.range(at: index), in: raw) else { return nil }
            return String(raw[range])
        }
        return "\(group(1) ?? "0").\(group(2) ?? "0").\(group(3) ?? "0")"
    }

    /// Studio lives at `/app` on the site (apps/web router).
    public static func studioURL(apiBase: String) -> URL? {
        siteOrigin(apiBase: apiBase)?.appendingPathComponent("app")
    }

    /// Effect library (completed works). Used by 「创作你自己的灯效」.
    public static func libraryURL(apiBase: String) -> URL? {
        siteOrigin(apiBase: apiBase)?.appendingPathComponent("library")
    }

    /// The download page used by "Check for updates" until Sparkle lands.
    public static func downloadPageURL(apiBase: String) -> URL? {
        siteOrigin(apiBase: apiBase)?.appendingPathComponent("player")
    }

    public static func siteOrigin(apiBase: String) -> URL? {
        guard var components = URLComponents(string: apiBase) else { return nil }
        var path = components.path
        if path.hasSuffix("/") {
            path.removeLast()
        }
        if path.hasSuffix("/api") {
            path.removeLast(4)
        }
        components.path = path
        return components.url
    }

    public static func make(
        environment: [String: String],
        defaultsAPIBase: String?,
        defaultsOpenRGBAddr: String?,
        infoPlistAPIBase: String?,
        appVersion: String,
        osVersionString: String,
        preferredLanguages: [String],
        home: URL
    ) -> BridgeConfig {
        let dataDirectory = dataDirectory(home: home)
        try? FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        return BridgeConfig(
            dataDir: dataDirectory.path,
            apiBase: resolveAPIBase(
                environment: environment,
                defaults: defaultsAPIBase,
                infoPlist: infoPlistAPIBase
            ),
            language: language(preferredLanguages: preferredLanguages),
            appVersion: appVersion,
            osVersion: normalizeOSVersion(osVersionString),
            openrgbAddr: resolveOpenRGBAddr(
                environment: environment,
                defaults: defaultsOpenRGBAddr
            )
        )
    }

    public static func current(
        processInfo: ProcessInfo = .processInfo,
        defaults: UserDefaults = .standard,
        bundle: Bundle = .main,
        fileManager: FileManager = .default
    ) -> BridgeConfig {
        let infoPlist = bundle.object(forInfoDictionaryKey: "RGBPAPIBase") as? String
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return make(
            environment: processInfo.environment,
            defaultsAPIBase: defaults.string(forKey: "apiBase"),
            defaultsOpenRGBAddr: defaults.string(forKey: "openrgbAddr"),
            infoPlistAPIBase: infoPlist,
            appVersion: version ?? "0.0.0",
            osVersionString: processInfo.operatingSystemVersionString,
            preferredLanguages: Locale.preferredLanguages,
            home: fileManager.homeDirectoryForCurrentUser
        )
    }

    private static func trimTrailingSlash(_ value: String) -> String {
        value.hasSuffix("/") ? String(value.dropLast()) : value
    }
}
