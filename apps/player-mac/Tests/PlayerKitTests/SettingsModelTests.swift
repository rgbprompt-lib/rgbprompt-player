import Foundation
import XCTest
@testable import PlayerKit

@MainActor
final class SettingsModelTests: XCTestCase {
    nonisolated(unsafe) private var suites: [String] = []

    override func tearDown() {
        for suite in suites {
            UserDefaults.standard.removePersistentDomain(forName: suite)
        }
        suites.removeAll()
        super.tearDown()
    }

    private func defaults() -> UserDefaults {
        let suite = "SettingsModelTests.\(UUID().uuidString)"
        suites.append(suite)
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func driver(
        installed: Bool,
        mode: String = "managed",
        version: String = "1.1",
        port: Int? = 6742,
        external: Bool = false
    ) -> DriverInfo {
        DriverInfo(
            variant: "standard",
            version: version,
            installed: installed,
            mode: mode,
            port: port,
            supervision: DriverSupervision(external: external)
        )
    }

    func testDriverRowVariants() {
        let managed = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: driver(installed: true),
            lastKeyboardName: nil,
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(managed.driver.detail, .driverReady(version: "1.1"))
        XCTAssertTrue(managed.driver.ok)

        let external = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: driver(installed: true, mode: "external", external: true),
            lastKeyboardName: nil,
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(external.driver.detail, .driverExternal(port: 6742))
        XCTAssertTrue(external.driver.ok)

        // External SDK without a managed install marker — the real Mac layout
        // when OpenRGB lives in /Applications or ~/.rgbprompt and Player never
        // wrote installed.json under data_dir/openrgb.
        let externalOnly = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: driver(installed: false, mode: "external", external: true),
            lastKeyboardName: nil,
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(externalOnly.driver.detail, .driverExternal(port: 6742))
        XCTAssertTrue(externalOnly.driver.ok)

        let localApp = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: driver(installed: false),
            lastKeyboardName: nil,
            schemeRegistered: true,
            localOpenRGBPresent: true,
            localOpenRGBVersion: "1.0"
        )
        XCTAssertEqual(localApp.driver.detail, .driverReady(version: "1.0"))
        XCTAssertTrue(localApp.driver.ok)

        let missing = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: driver(installed: false),
            lastKeyboardName: nil,
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(missing.driver.detail, .driverMissing)
        XCTAssertFalse(missing.driver.ok)
    }

    func testKeyboardRowUsesLastSeenNameOnlyWhenPlayingOrIdle() {
        let known = SettingsStatusBuilder.build(
            state: .playing,
            driverInfo: driver(installed: true),
            lastKeyboardName: "Redragon K580",
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(known.keyboard.detail, .keyboardName("Redragon K580"))
        XCTAssertTrue(known.keyboard.ok)

        let idle = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: driver(installed: true),
            lastKeyboardName: "Redragon K580",
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(idle.keyboard.detail, .keyboardName("Redragon K580"))
        XCTAssertTrue(idle.keyboard.ok)

        let lost = SettingsStatusBuilder.build(
            state: .noKeyboard(deviceLost: true),
            driverInfo: driver(installed: true),
            lastKeyboardName: "Redragon K580",
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(lost.keyboard.detail, .keyboardMissing)
        XCTAssertFalse(lost.keyboard.ok)

        let empty = SettingsStatusBuilder.build(
            state: .playing,
            driverInfo: driver(installed: true),
            lastKeyboardName: "  ",
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(empty.keyboard.detail, .keyboardMissing)
    }

    func testWebLinkRowVariants() {
        let registered = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: nil,
            lastKeyboardName: nil,
            schemeRegistered: true,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(registered.webLink.detail, .webRegistered)
        XCTAssertTrue(registered.webLink.ok)
        XCTAssertFalse(registered.webLink.showsMakeDefault)

        let missing = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: nil,
            lastKeyboardName: nil,
            schemeRegistered: false,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(missing.webLink.detail, .webMissing)
        XCTAssertFalse(missing.webLink.ok)
        XCTAssertTrue(missing.webLink.showsMakeDefault)
    }

    func testStatusRowsUseStableTitleKeys() {
        let status = SettingsStatusBuilder.build(
            state: .idle(failure: nil),
            driverInfo: nil,
            lastKeyboardName: nil,
            schemeRegistered: false,
            localOpenRGBPresent: false
        )
        XCTAssertEqual(status.driver.titleKey, "settings.status.driver")
        XCTAssertEqual(status.keyboard.titleKey, "settings.status.keyboard")
        XCTAssertEqual(status.webLink.titleKey, "settings.status.webLink")
        XCTAssertEqual(status.rows.count, 3)
    }

    func testBrightnessClampsToTenThroughHundred() {
        XCTAssertEqual(BrightnessPreference.clamp(-20), 10)
        XCTAssertEqual(BrightnessPreference.clamp(0), 10)
        XCTAssertEqual(BrightnessPreference.clamp(55), 55)
        XCTAssertEqual(BrightnessPreference.clamp(100), 100)
        XCTAssertEqual(BrightnessPreference.clamp(140), 100)

        let model = SettingsModel(defaults: defaults())
        model.setBrightness(3)
        XCTAssertEqual(model.brightness, 10)
        model.setBrightness(999)
        XCTAssertEqual(model.brightness, 100)
    }

    func testPreferencesPersistInIsolatedDefaults() {
        let store = defaults()
        let model = SettingsModel(defaults: store)
        XCTAssertEqual(model.audioEnabled, true, "default is on")
        XCTAssertEqual(model.brightness, 100, "default is 100")

        model.setAudioEnabled(false)
        model.setBrightness(45)

        let reloaded = SettingsModel(defaults: store)
        XCTAssertFalse(reloaded.audioEnabled)
        XCTAssertEqual(reloaded.brightness, 45)
    }

    func testDownloadPageURLFollowsAPIBase() {
        XCTAssertEqual(
            BridgeConfigBuilder.downloadPageURL(apiBase: "https://rgbprompt.com/api")?.absoluteString,
            "https://rgbprompt.com/player"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.downloadPageURL(apiBase: "http://127.0.0.1:5173/api")?.absoluteString,
            "http://127.0.0.1:5173/player"
        )
    }
}
