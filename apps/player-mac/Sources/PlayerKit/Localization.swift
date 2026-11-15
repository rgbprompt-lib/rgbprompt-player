import Foundation

private final class PlayerKitBundleToken {}

/// Locates the bundle that carries the PlayerKit string tables. In the app and
/// in the unhosted test bundle the tables are copied next to the executable.
public enum PlayerKitResources {
    public static var bundle: Bundle {
        let tokenBundle = Bundle(for: PlayerKitBundleToken.self)
        if tokenBundle.path(forResource: "Localizable", ofType: "strings") != nil {
            return tokenBundle
        }
        if Bundle.main.path(forResource: "Localizable", ofType: "strings") != nil {
            return Bundle.main
        }
        return tokenBundle
    }
}

public enum L10n {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var language: PlayerLanguage = .english
    nonisolated(unsafe) private static var tables: [PlayerLanguage: [String: String]] = [:]

    /// Switches the table every subsequent `tr` / `format` reads. The UI store
    /// calls this before publishing the new language.
    static func setLanguage(_ value: PlayerLanguage) {
        lock.lock()
        language = value
        lock.unlock()
    }

    public static var currentLanguage: PlayerLanguage {
        lock.lock()
        defer { lock.unlock() }
        return language
    }

    public static func tr(_ key: String) -> String {
        tr(key, language: currentLanguage)
    }

    private static func tr(_ key: String, language: PlayerLanguage) -> String {
        if let value = table(for: language)[key] {
            return value
        }
        if language != .english, let fallback = table(for: .english)[key] {
            return fallback
        }
        return key
    }

    public static func format(_ key: String, _ arguments: CVarArg...) -> String {
        let language = currentLanguage
        return String(format: tr(key, language: language), locale: language.locale, arguments: arguments)
    }

    public static func format(_ key: String, arguments: [CVarArg]) -> String {
        let language = currentLanguage
        return String(format: tr(key, language: language), locale: language.locale, arguments: arguments)
    }

    private static func table(for language: PlayerLanguage) -> [String: String] {
        lock.lock()
        defer { lock.unlock() }
        if let cached = tables[language] {
            return cached
        }
        let loaded = load(language)
        tables[language] = loaded
        return loaded
    }

    private static func load(_ language: PlayerLanguage) -> [String: String] {
        let bundle = PlayerKitResources.bundle
        guard
            let lprojPath = bundle.path(forResource: language.resourceName, ofType: "lproj"),
            let lproj = Bundle(path: lprojPath),
            let stringsPath = lproj.path(forResource: "Localizable", ofType: "strings"),
            let data = FileManager.default.contents(atPath: stringsPath),
            let plist = try? PropertyListSerialization.propertyList(from: data, format: nil),
            let table = plist as? [String: String]
        else {
            return [:]
        }
        return table
    }
}

/// Every key the shell uses. The XCTest suite checks that both `en` and
/// `zh-Hans` contain all of them.
public enum LocalizationKeys {
    public static let panel: [String] = [
        "app.name",
        "panel.status.connected",
        "panel.status.preparing",
        "panel.status.driverNeeded",
        "panel.status.noKeyboard",
        "panel.status.backendUnresponsive",
        "panel.status.restartingDriver",
        "panel.status.openrgbNotRunning",
        "panel.status.vendorConflict",
        "panel.status.blocked",
        "panel.status.internalError",
        "panel.nowPlaying",
        "panel.untitled",
        "panel.keyboard.fallback",
        "panel.stop",
        "panel.stoppedHint",
        "panel.meta.fps",
        "panel.meta.fpsSupport",
        "support.unknown",
        "support.perKey",
        "support.zones",
        "support.single",
        "panel.openStudio",
        "panel.presets.playing",
        "panel.presets.audio",
        "panel.presets.title",
        "panel.createEffect",
        "panel.picker.choose",
        "panel.picker.create",
        "panel.source.preset",
        "panel.source.web",
        "panel.source.file",
        "panel.idle.dropHere",
        "panel.drop.release",
        "panel.chip.audio",
        "panel.chip.keyOff",
        "panel.chip.audioOff",
        "panel.chip.enable",
        "panel.more",
        "panel.more.keyboards",
        "panel.hide",
        "panel.status.ready",
        "panel.idle.drop",
        "panel.preparing",
        "panel.failure.title",
        "panel.failure.line",
        "panel.needsDriver.title",
        "panel.needsDriver.body",
        "panel.needsDriver.bullet.summary",
        "panel.needsDriver.bullet.versionOnly",
        "panel.needsDriver.bullet.verified",
        "panel.needsDriver.bullet.safe",
        "panel.needsDriver.install",
        "panel.needsDriver.later",
        "panel.needsDriver.percent",
        "panel.noKeyboard.title",
        "panel.noKeyboard.subtitle",
        "panel.noKeyboard.check1",
        "panel.noKeyboard.check2",
        "panel.noKeyboard.check3",
        "panel.noKeyboard.findAgain",
        "panel.noKeyboard.supported",
        "panel.noKeyboard.footer",
        "panel.noKeyboard.deviceLost",
        "panel.backend.restarting.title",
        "panel.backend.restarting.body",
        "panel.backend.gaveUp.title",
        "panel.backend.gaveUp.body",
        "panel.backend.external.title",
        "panel.backend.external.body",
        "panel.backend.waiting",
        "panel.backend.retryNow",
        "panel.backend.unresponsive.title",
        "panel.backend.unresponsive.body",
        "panel.backend.restart",
        "panel.backend.copyDiagnostics",
        "panel.backend.copied",
        "panel.vendor.title",
        "panel.vendor.fallbackName",
        "panel.vendor.body",
        "panel.vendor.step1",
        "panel.vendor.step2",
        "panel.vendor.step3",
        "panel.vendor.retry",
        "panel.vendor.openActivityMonitor",
        "panel.blocked.title",
        "panel.blocked.line",
        "panel.blocked.showSteps",
        "panel.blocked.retry",
        "panel.coreUnavailable.title",
        "panel.coreUnavailable.body",
        "panel.footer.studio",
        "panel.footer.playLep",
        "panel.footer.settings",
        "panel.footer.quit",
        "panel.footer.reopenVendors",
        "panel.footer.defaultHandler",
        "panel.input.key.explain.title",
        "panel.input.key.explain.body",
        "panel.input.continue",
        "panel.input.notNow",
        "panel.input.key.denied.title",
        "panel.input.key.path",
        "panel.input.openSettings",
        "panel.input.key.relaunch",
        "panel.input.key.quit",
        "panel.input.audio.title",
        "panel.input.audio.path",
        "panel.audio.source.title",
        "panel.audio.source.body",
        "setup.title",
        "setup.step.driver",
        "setup.step.gatekeeper",
        "setup.install.title",
        "setup.install.installingTitle",
        "setup.install.body",
        "setup.table.contents",
        "setup.table.size",
        "setup.table.location",
        "setup.table.verification",
        "setup.table.versionOfficial",
        "setup.table.versionTuned",
        "setup.size.about",
        "setup.verification.value",
        "setup.progress.download",
        "setup.progress.eta",
        "setup.progress.etaLess",
        "setup.progress.starting",
        "setup.button.later",
        "setup.button.install",
        "setup.button.cancel",
        "setup.button.installing",
        "setup.button.retry",
        "setup.button.tryAgain",
        "setup.button.showInFinder",
        "setup.button.allowedRetry",
        "setup.button.copy",
        "setup.button.copied",
        "setup.unverified.warning",
        "setup.unverified.external",
        "setup.failed.1",
        "setup.failed.2",
        "setup.failed.3",
        "setup.gatekeeper.title",
        "setup.gatekeeper.body",
        "setup.gatekeeper.step1",
        "setup.gatekeeper.step2",
        "setup.gatekeeper.step3",
        "setup.gatekeeper.openSettings",
        "settings.title",
        "settings.section.status",
        "settings.section.preferences",
        "settings.status.driver",
        "settings.status.keyboard",
        "settings.status.webLink",
        "settings.status.driverReady",
        "settings.status.driverExternal",
        "settings.status.driverMissing",
        "settings.status.keyboardMissing",
        "settings.status.webRegistered",
        "settings.status.webMissing",
        "settings.webLink.makeDefault",
        "settings.preference.language",
        "settings.language.chinese",
        "settings.language.english",
        "settings.preference.sound",
        "settings.sound.system",
        "settings.sound.off",
        "settings.preference.brightness",
        "settings.brightness.value",
        "settings.preference.launchAtLogin",
        "settings.launch.hint",
        "settings.launch.requiresApproval",
        "settings.launch.openLoginItems",
        "settings.launch.notFound",
        "settings.login.error",
        "settings.stop.title",
        "settings.stop.body",
        "settings.footer.version",
        "settings.footer.checkUpdates",
        "settings.footer.copyDiagnostics",
        "settings.footer.copied",
        "settings.footer.licenses",
        ]

    public static var all: [String] {
        FailureCode.allCases.map(\.localizationKey) + panel
    }
}
