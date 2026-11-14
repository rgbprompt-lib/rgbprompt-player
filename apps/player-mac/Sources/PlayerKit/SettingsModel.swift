import Combine
import Foundation

/// The right-hand detail of a status row. Keeping it as data (instead of a
/// formatted string) lets tests assert the state without depending on the
/// selected language.
public enum SettingsDetail: Equatable, Sendable {
    case driverReady(version: String)
    case driverExternal(port: Int)
    case driverMissing
    case keyboardName(String)
    case keyboardMissing
    case webRegistered
    case webMissing
}

public struct SettingsStatusRow: Equatable, Sendable {
    public let titleKey: String
    public let detail: SettingsDetail
    public let ok: Bool
    public let showsMakeDefault: Bool

    public init(
        titleKey: String,
        detail: SettingsDetail,
        ok: Bool,
        showsMakeDefault: Bool = false
    ) {
        self.titleKey = titleKey
        self.detail = detail
        self.ok = ok
        self.showsMakeDefault = showsMakeDefault
    }
}

public struct SettingsStatus: Equatable, Sendable {
    public let driver: SettingsStatusRow
    public let keyboard: SettingsStatusRow
    public let webLink: SettingsStatusRow

    public init(
        driver: SettingsStatusRow,
        keyboard: SettingsStatusRow,
        webLink: SettingsStatusRow
    ) {
        self.driver = driver
        self.keyboard = keyboard
        self.webLink = webLink
    }

    public var rows: [SettingsStatusRow] {
        [driver, keyboard, webLink]
    }
}

public enum SettingsStatusBuilder {
    public static func build(
        state: PanelState,
        driverInfo: DriverInfo?,
        lastKeyboardName: String?,
        schemeRegistered: Bool,
        localOpenRGBPresent: Bool = false,
        localOpenRGBVersion: String? = nil
    ) -> SettingsStatus {
        let driver = driverRow(
            driverInfo,
            localOpenRGBPresent: localOpenRGBPresent,
            localOpenRGBVersion: localOpenRGBVersion
        )
        let keyboard = keyboardRow(state: state, lastKeyboardName: lastKeyboardName)
        let web = SettingsStatusRow(
            titleKey: "settings.status.webLink",
            detail: schemeRegistered ? .webRegistered : .webMissing,
            ok: schemeRegistered,
            showsMakeDefault: !schemeRegistered
        )
        return SettingsStatus(driver: driver, keyboard: keyboard, webLink: web)
    }

    private static func driverRow(
        _ info: DriverInfo?,
        localOpenRGBPresent: Bool,
        localOpenRGBVersion: String?
    ) -> SettingsStatusRow {
        // Match PLAYER §4 / core resolve: a live (or last-known) external SDK
        // server counts even when the managed install marker is absent. The
        // previous `installed == true` gate wrongly showed "Not installed"
        // whenever the user ran their own OpenRGB (/Applications or
        // ~/.rgbprompt/OpenRGB-RGBPrompt.app) without going through Player's
        // download flow.
        let external = info?.mode == "external" || info?.supervision?.external == true
        if external {
            return SettingsStatusRow(
                titleKey: "settings.status.driver",
                detail: .driverExternal(port: info?.port ?? 6742),
                ok: true
            )
        }
        if info?.installed == true {
            return SettingsStatusRow(
                titleKey: "settings.status.driver",
                detail: .driverReady(version: info?.version ?? "—"),
                ok: true
            )
        }
        if localOpenRGBPresent {
            return SettingsStatusRow(
                titleKey: "settings.status.driver",
                detail: .driverReady(version: localOpenRGBVersion ?? info?.version ?? "—"),
                ok: true
            )
        }
        return SettingsStatusRow(
            titleKey: "settings.status.driver",
            detail: .driverMissing,
            ok: false
        )
    }

    private static func keyboardRow(
        state: PanelState,
        lastKeyboardName: String?
    ) -> SettingsStatusRow {
        let name = lastKeyboardName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let eligible: Bool
        switch state {
        case .playing, .idle:
            eligible = true
        default:
            eligible = false
        }
        if eligible, !name.isEmpty {
            return SettingsStatusRow(
                titleKey: "settings.status.keyboard",
                detail: .keyboardName(name),
                ok: true
            )
        }
        return SettingsStatusRow(
            titleKey: "settings.status.keyboard",
            detail: .keyboardMissing,
            ok: false
        )
    }
}

/// Drives the settings window (PLY-15, PLY-17). Status rows are derived from
/// bridge snapshots; preferences are persisted in `UserDefaults` and applied
/// by `AppController` through its subscriptions.
@MainActor
public final class SettingsModel: ObservableObject {
    @Published public private(set) var rowState: PanelState = .idle(failure: nil)
    @Published public private(set) var driverInfo: DriverInfo?
    @Published public private(set) var lastKeyboardName: String = ""
    @Published public private(set) var schemeRegistered = true
    @Published public private(set) var audioEnabled: Bool
    @Published public private(set) var brightness: Int

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        audioEnabled = AudioPreference.load(defaults: defaults)
        brightness = BrightnessPreference.load(defaults: defaults)
    }

    public var status: SettingsStatus {
        let app = DriverPresence.firstPresentApp()
        return SettingsStatusBuilder.build(
            state: rowState,
            driverInfo: driverInfo,
            lastKeyboardName: lastKeyboardName,
            schemeRegistered: schemeRegistered,
            localOpenRGBPresent: app != nil,
            localOpenRGBVersion: app.flatMap(DriverPresence.shortVersion(of:))
        )
    }

    public func apply(
        state: PanelState,
        driverInfo: DriverInfo?,
        lastKeyboardName: String?,
        schemeRegistered: Bool
    ) {
        rowState = state
        self.driverInfo = driverInfo
        self.lastKeyboardName = lastKeyboardName ?? ""
        self.schemeRegistered = schemeRegistered
    }

    public func setAudioEnabled(_ enabled: Bool) {
        audioEnabled = enabled
        defaults.set(enabled, forKey: AudioPreference.key)
    }

    public func setBrightness(_ value: Int) {
        let clamped = BrightnessPreference.clamp(value)
        brightness = clamped
        defaults.set(clamped, forKey: BrightnessPreference.key)
    }
}

#if DEBUG
extension SettingsModel {
    /// Fixed data for offscreen previews; uses a throwaway defaults suite.
    public static func preview(
        state: PanelState = .playing,
        driverInfo: DriverInfo? = nil,
        keyboardName: String = "Redragon K580",
        schemeRegistered: Bool = true,
        audioEnabled: Bool = true,
        brightness: Int = 80
    ) -> SettingsModel {
        let suite = "SettingsModelPreview.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let model = SettingsModel(defaults: defaults)
        model.apply(
            state: state,
            driverInfo: driverInfo,
            lastKeyboardName: keyboardName,
            schemeRegistered: schemeRegistered
        )
        model.setAudioEnabled(audioEnabled)
        model.setBrightness(brightness)
        return model
    }
}
#endif
