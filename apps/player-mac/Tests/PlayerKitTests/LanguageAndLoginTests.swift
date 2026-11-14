import Combine
import Foundation
import XCTest
@testable import PlayerKit

@MainActor
final class LanguageAndLoginTests: XCTestCase {
    nonisolated(unsafe) private var suites: [String] = []

    override func tearDown() {
        for suite in suites {
            UserDefaults.standard.removePersistentDomain(forName: suite)
        }
        suites.removeAll()
        L10n.setLanguage(.english)
        super.tearDown()
    }

    private func defaults() -> UserDefaults {
        let suite = "LanguageAndLoginTests.\(UUID().uuidString)"
        suites.append(suite)
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    // MARK: - Language

    func testEffectiveLanguageFromStoredAndSystemPairs() {
        XCTAssertEqual(
            LanguageStore.resolve(stored: nil, system: ["zh-Hans-CN", "en"]),
            .chinese
        )
        XCTAssertEqual(
            LanguageStore.resolve(stored: nil, system: ["en-US"]),
            .english
        )
        XCTAssertEqual(
            LanguageStore.resolve(stored: "zh-CN", system: ["en-US"]),
            .chinese
        )
        XCTAssertEqual(
            LanguageStore.resolve(stored: "en", system: ["zh-Hans"]),
            .english
        )
        XCTAssertEqual(
            LanguageStore.resolve(stored: "fr", system: ["zh-Hans"]),
            .chinese,
            "unrecognised storage follows the system"
        )
    }

    func testL10nFollowsTheStoreIndependentOfProcessLocale() {
        let store = defaults()
        store.set("zh-CN", forKey: LanguageStore.defaultsKey)
        let language = LanguageStore(defaults: store, preferredLanguages: ["en-US"])
        XCTAssertEqual(language.effective, .chinese)
        XCTAssertEqual(L10n.tr("panel.stop"), "停止")
        XCTAssertEqual(L10n.tr("panel.footer.settings"), "设置…")

        language.set(.english)
        XCTAssertEqual(L10n.tr("panel.stop"), "Stop")
        XCTAssertEqual(L10n.tr("panel.footer.settings"), "Settings…")
    }

    func testSubscribersSeeTheNewLanguageSynchronously() {
        let language = LanguageStore(defaults: defaults(), preferredLanguages: ["en-US"])
        var seen: [String] = []
        let token = language.$effective.dropFirst().sink { _ in
            seen.append(L10n.tr("panel.stop"))
        }
        language.set(.chinese)
        language.set(.english)
        token.cancel()
        XCTAssertEqual(seen, ["停止", "Stop"])
    }

    func testFormatUsesTheSelectedLocale() {
        let store = defaults()
        let language = LanguageStore(defaults: store, preferredLanguages: ["en-US"])
        language.set(.chinese)
        XCTAssertTrue(L10n.format("setup.progress.eta", 12).contains("12"))
        XCTAssertTrue(L10n.format("setup.progress.eta", 12).contains("秒"))

        language.set(.english)
        XCTAssertEqual(L10n.format("setup.progress.eta", 12), "About 12 s")
    }

    // MARK: - Login item

    func testLoginItemOffToOnRegisters() {
        let controller = FakeLoginItem(status: .notRegistered)
        let model = LoginItemModel(controller: controller)
        XCTAssertFalse(model.isOn)

        model.toggle(on: true)

        XCTAssertTrue(model.isOn)
        XCTAssertEqual(model.status, .enabled)
        XCTAssertNil(model.errorKey)
        XCTAssertEqual(controller.registerCount, 1)
    }

    func testLoginItemOnToOffUnregisters() {
        let controller = FakeLoginItem(status: .enabled)
        let model = LoginItemModel(controller: controller)

        model.toggle(on: false)

        XCTAssertFalse(model.isOn)
        XCTAssertEqual(model.status, .notRegistered)
        XCTAssertEqual(controller.unregisterCount, 1)
    }

    func testRegisterErrorRevertsTheSwitchAndSetsErrorKey() {
        let controller = FakeLoginItem(status: .notRegistered)
        controller.registerError = FakeLoginError()
        let model = LoginItemModel(controller: controller)

        model.toggle(on: true)

        XCTAssertFalse(model.isOn)
        XCTAssertEqual(model.status, .notRegistered)
        XCTAssertEqual(model.errorKey, LoginItemModel.errorKey)
    }

    func testRequiresApprovalCountsAsOnAndOffersTheHint() {
        let controller = FakeLoginItem(status: .notRegistered)
        controller.registerResult = .requiresApproval
        let model = LoginItemModel(controller: controller)

        model.toggle(on: true)

        XCTAssertTrue(model.isOn)
        XCTAssertTrue(model.needsApproval)
        XCTAssertEqual(model.status, .requiresApproval)

        model.toggle(on: false)
        XCTAssertFalse(model.isOn)
        XCTAssertEqual(model.status, .notRegistered)
    }

    func testNotFoundDisablesTheSwitchOutsideApplications() {
        let controller = FakeLoginItem(status: .notFound)
        let model = LoginItemModel(controller: controller, isInApplications: false)

        XCTAssertFalse(model.isToggleEnabled)
        XCTAssertFalse(model.isOn)
        XCTAssertTrue(model.isNotFound)
    }

    func testNotFoundInApplicationsStillAllowsRegistering() {
        let controller = FakeLoginItem(status: .notFound)
        let model = LoginItemModel(controller: controller, isInApplications: true)

        XCTAssertTrue(model.isToggleEnabled)
        XCTAssertFalse(model.isNotFound)
    }

    func testApplicationsFolderDetection() {
        XCTAssertTrue(LoginItemModel.isInApplicationsFolder(
            URL(fileURLWithPath: "/Applications/RGBPrompt Player.app")))
        XCTAssertFalse(LoginItemModel.isInApplicationsFolder(
            URL(fileURLWithPath: "/Volumes/RGBPrompt/RGBPrompt Player.app")))
        XCTAssertFalse(LoginItemModel.isInApplicationsFolder(
            URL(fileURLWithPath: "/tmp/build/Release/RGBPrompt Player.app")))
    }

    func testRefreshReReadsTheSystemStatus() {
        let controller = FakeLoginItem(status: .notRegistered)
        let model = LoginItemModel(controller: controller)
        controller.status = .enabled

        model.refresh()

        XCTAssertTrue(model.isOn)
    }

    private struct FakeLoginError: Error {}

    private final class FakeLoginItem: LoginItemControlling {
        var status: LoginItemStatus
        var registerResult: LoginItemStatus = .enabled
        var registerError: Error?
        var unregisterError: Error?
        private(set) var registerCount = 0
        private(set) var unregisterCount = 0
        private(set) var openCount = 0

        init(status: LoginItemStatus) {
            self.status = status
        }

        func register() throws {
            registerCount += 1
            if let registerError {
                throw registerError
            }
            status = registerResult
        }

        func unregister() throws {
            unregisterCount += 1
            if let unregisterError {
                throw unregisterError
            }
            status = .notRegistered
        }

        func openSystemSettings() {
            openCount += 1
        }
    }
}
