import Combine
import Foundation

/// The two languages the shipped Player speaks. `zh-CN` maps onto the
/// `zh-Hans.lproj` table; the core receives the same `en` / `zh-CN` values.
public enum PlayerLanguage: String, CaseIterable, Equatable, Sendable {
    case english = "en"
    case chinese = "zh-CN"

    public var resourceName: String {
        switch self {
        case .english: return "en"
        case .chinese: return "zh-Hans"
        }
    }

    public var locale: Locale {
        Locale(identifier: resourceName)
    }
}

/// Single source of truth for the effective UI language (PLY-17). `L10n` reads
/// the static mirror so non-view code can format strings without threading the
/// store through every call.
@MainActor
public final class LanguageStore: ObservableObject {
    public static let defaultsKey = "language"

    @Published public private(set) var effective: PlayerLanguage

    private let defaults: UserDefaults

    public init(
        defaults: UserDefaults = .standard,
        preferredLanguages: [String] = Locale.preferredLanguages
    ) {
        self.defaults = defaults
        let resolved = Self.resolve(
            stored: defaults.string(forKey: Self.defaultsKey),
            system: preferredLanguages
        )
        effective = resolved
        L10n.setLanguage(resolved)
    }

    /// Absent or unrecognised storage follows the system, matching the old
    /// behaviour. Picking a segment stores it explicitly.
    public static func resolve(stored: String?, system: [String]) -> PlayerLanguage {
        switch stored?.lowercased() {
        case "en":
            return .english
        case "zh-cn", "zh-hans":
            return .chinese
        default:
            return BridgeConfigBuilder.language(preferredLanguages: system) == "zh-CN"
                ? .chinese
                : .english
        }
    }

    public func set(_ language: PlayerLanguage) {
        defaults.set(language.rawValue, forKey: Self.defaultsKey)
        // Update L10n first: `$effective` emits in willSet, and its subscribers
        // (window titles, status item tooltip) read L10n synchronously.
        L10n.setLanguage(language)
        guard language != effective else { return }
        effective = language
    }
}
