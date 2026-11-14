import Combine
import Foundation
import XCTest
@testable import PlayerKit

@MainActor
final class DriverUITests: XCTestCase {
    private func info(verified: Bool = true, supervision: DriverSupervision? = nil) -> DriverInfo {
        DriverInfo(
            variant: "standard",
            version: "1.0",
            sizeBytes: 44_000_000,
            installDir: "/Users/me/.rgbprompt/openrgb/standard-1.0",
            source: "https://openrgb.org",
            license: "GPL-2.0-only",
            installed: false,
            mode: "none",
            port: nil,
            executable: "/Users/me/.rgbprompt/openrgb/standard-1.0/OpenRGB.app/Contents/MacOS/OpenRGB",
            verified: verified,
            supervision: supervision
        )
    }

    func testSetupWindowOpensOnlyAfterAPlayRequest() {
        let model = SetupWindowModel()
        model.apply(state: .idle(failure: nil), driverInfo: info())
        XCTAssertFalse(model.isOpen)
        model.apply(state: .needsDriver(progress: nil, driverError: 0), driverInfo: info())
        XCTAssertFalse(model.isOpen, "NeedsDriver without a play request does not pop the window")

        model.notePlayRequest()
        model.apply(state: .preparing, driverInfo: info())
        model.apply(state: .needsDriver(progress: nil, driverError: 0), driverInfo: info())
        XCTAssertTrue(model.isOpen)
        XCTAssertEqual(model.step, 1)
        XCTAssertEqual(model.content, .install)

        model.apply(state: .playing, driverInfo: info())
        XCTAssertFalse(model.isOpen)
    }

    func testClosedWindowStaysClosedDuringInstallProgress() {
        let model = SetupWindowModel()
        model.notePlayRequest()
        model.apply(state: .preparing, driverInfo: info())
        model.apply(state: .needsDriver(progress: nil, driverError: 0), driverInfo: info())
        XCTAssertTrue(model.isOpen)
        model.close()
        model.apply(state: .needsDriver(progress: 10, driverError: 0), driverInfo: info())
        model.apply(state: .needsDriver(progress: 20, driverError: 0), driverInfo: info())
        XCTAssertFalse(model.isOpen, "progress events must not reopen a window the user closed")
        model.apply(state: .blocked, driverInfo: info())
        XCTAssertTrue(model.isOpen, "a new state kind opens it again")
    }

    func testBlockedUsesStepTwoAndClosesOnIdle() {
        let model = SetupWindowModel()
        model.notePlayRequest()
        model.apply(state: .blocked, driverInfo: info())
        XCTAssertTrue(model.isOpen)
        XCTAssertEqual(model.step, 2)
        XCTAssertEqual(model.content, .blocked)

        model.apply(state: .idle(failure: nil), driverInfo: info())
        XCTAssertFalse(model.isOpen)
    }

    func testSetupWindowVariants() {
        let model = SetupWindowModel()
        model.notePlayRequest()

        model.apply(
            state: .needsDriver(progress: nil, driverError: 0),
            driverInfo: info(verified: false)
        )
        XCTAssertEqual(model.content, .unverified)

        model.apply(
            state: .needsDriver(progress: nil, driverError: 2),
            driverInfo: info(verified: true)
        )
        XCTAssertEqual(model.content, .installFailed(2))

        model.apply(
            state: .needsDriver(progress: 37, driverError: 0),
            driverInfo: info(verified: true)
        )
        XCTAssertEqual(model.content, .installing)
        XCTAssertEqual(model.progress, 37)
        XCTAssertTrue(model.isInstalling)
    }

    func testProgressEstimatorNeedsTwoSamples() {
        var estimator = ProgressEstimator()
        XCTAssertNil(estimator.sample(progress: 10, totalBytes: 44_000_000, time: 100))
        XCTAssertFalse(estimator.isReady)
        let estimate = estimator.sample(progress: 30, totalBytes: 44_000_000, time: 101)
        XCTAssertNotNil(estimate)
        XCTAssertEqual(estimate?.bytesPerSecond ?? 0, 8_800_000, accuracy: 1)
        XCTAssertEqual(estimate?.etaSeconds ?? 0, 3.5, accuracy: 0.01)
        XCTAssertTrue(estimator.isReady)
    }

    func testMegabyteFormattingInBothLanguages() throws {
        XCTAssertEqual(SetupFormatting.wholeMegabytes(44_000_000), "44")
        XCTAssertNil(SetupFormatting.wholeMegabytes(0))
        let line = SetupFormatting.downloadLine(progress: 63, totalBytes: 44_000_000)
        XCTAssertTrue(line.contains("27.7"), line)
        XCTAssertTrue(line.contains("44"), line)

        let bundle = PlayerKitResources.bundle
        for language in ["en", "zh-Hans"] {
            let lprojPath = try XCTUnwrap(bundle.path(forResource: language, ofType: "lproj"))
            let lproj = try XCTUnwrap(Bundle(path: lprojPath))
            let stringsPath = try XCTUnwrap(lproj.path(forResource: "Localizable", ofType: "strings"))
            let data = try Data(contentsOf: URL(fileURLWithPath: stringsPath))
            let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
            let table = try XCTUnwrap(plist as? [String: String])
            let template = try XCTUnwrap(table["setup.size.about"])
            XCTAssertTrue(String(format: template, "44").contains("44"))
        }
    }

    func testDriverPaths() {
        XCTAssertEqual(
            DriverPaths.appBundle(
                fromExecutable:
                    "/Users/me/.rgbprompt/openrgb/standard-1.0/OpenRGB.app/Contents/MacOS/OpenRGB"
            ),
            "/Users/me/.rgbprompt/openrgb/standard-1.0/OpenRGB.app"
        )
        XCTAssertNil(DriverPaths.appBundle(fromExecutable: "/usr/local/bin/openrgb"))
        XCTAssertEqual(DriverPaths.abbreviateHome("/Users/me/.rgbprompt", home: "/Users/me"), "~/.rgbprompt")
        XCTAssertEqual(DriverPaths.abbreviateHome("/Users/me", home: "/Users/me"), "~")
        XCTAssertEqual(DriverPaths.abbreviateHome("/opt/openrgb", home: "/Users/me"), "/opt/openrgb")
    }

    func testDriverPresenceCandidates() {
        let home = URL(fileURLWithPath: "/Users/me", isDirectory: true)
        let apps = DriverPresence.candidateApps(home: home).map(\.path)
        XCTAssertEqual(
            apps,
            [
                "/Applications/OpenRGB.app",
                "/Users/me/Applications/OpenRGB.app",
                "/Users/me/.rgbprompt/OpenRGB.app",
                "/Users/me/.rgbprompt/OpenRGB-RGBPrompt.app",
            ]
        )
    }

    func testBackendIssueFromSupervision() {
        let restarting = DriverSupervision(
            state: "restarting",
            crashes: 1,
            crashLimit: 3,
            external: false
        )
        XCTAssertEqual(
            BackendIssue.from(
                state: .backendUnresponsive,
                driverInfo: info(supervision: restarting)
            ),
            .restarting(attempt: 1, limit: 3)
        )
        XCTAssertEqual(
            BackendIssue.from(
                state: .backendUnresponsive,
                driverInfo: info(supervision: DriverSupervision(state: "gaveUp", crashes: 4, crashLimit: 3, external: false))
            ),
            .gaveUp
        )
        let external = DriverInfo(
            port: 6742,
            verified: true,
            supervision: DriverSupervision(state: "externalLost", crashes: 0, crashLimit: 3, external: true)
        )
        XCTAssertEqual(
            BackendIssue.from(state: .backendUnresponsive, driverInfo: external),
            .externalLost(port: 6742)
        )
        XCTAssertEqual(
            BackendIssue.from(state: .backendUnresponsive, driverInfo: info()),
            .unresponsive
        )
        XCTAssertNil(BackendIssue.from(state: .playing, driverInfo: info()))
    }

    func testDriverInfoDecodingWithAndWithoutNewFields() throws {
        let old = #"{"variant":"standard","version":"1.0","sizeBytes":100,"installDir":"/tmp","installed":false,"mode":"none","port":null}"#
        let oldInfo = try JSONDecoder().decode(DriverInfo.self, from: Data(old.utf8))
        XCTAssertNil(oldInfo.verified)
        XCTAssertNil(oldInfo.supervision)
        XCTAssertFalse(oldInfo.isVerified)

        let new = #"{"variant":"standard","version":"1.0","sizeBytes":100,"installDir":"/tmp","installed":true,"mode":"managed","port":6743,"verified":true,"supervision":{"state":"restarting","crashes":1,"crashLimit":3,"external":false}}"#
        let newInfo = try JSONDecoder().decode(DriverInfo.self, from: Data(new.utf8))
        XCTAssertTrue(newInfo.isVerified)
        XCTAssertEqual(newInfo.supervision?.kind, .restarting)
        XCTAssertEqual(newInfo.supervision?.crashes, 1)
        XCTAssertEqual(newInfo.supervision?.crashLimit, 3)
    }

    func testDeviceChangeCoalescerCollapsesABurst() {
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var actions: [@Sendable () -> Void] = []
            var flushes: [(Int, Int)] = []

            func append(_ action: @escaping @Sendable () -> Void) {
                lock.lock()
                actions.append(action)
                lock.unlock()
            }

            func runAll() {
                lock.lock()
                let actions = self.actions
                self.actions.removeAll()
                lock.unlock()
                for action in actions {
                    action()
                }
            }
        }

        let box = Box()
        let coalescer = DeviceChangeCoalescer(delay: 0.3) { _, action in
            box.append(action)
        }
        coalescer.onFlush = { added, removed in
            box.lock.lock()
            box.flushes.append((added, removed))
            box.lock.unlock()
        }
        for _ in 0..<5 {
            coalescer.record(added: 1, removed: 0)
        }
        box.lock.lock()
        let scheduled = box.actions.count
        box.lock.unlock()
        XCTAssertEqual(scheduled, 1, "a burst schedules one flush")
        box.runAll()
        XCTAssertEqual(box.flushes.count, 1)
        XCTAssertEqual(box.flushes.first?.0, 5)
        XCTAssertEqual(box.flushes.first?.1, 0)
    }

    func testIOKitWatcherDoesNotNotifyOnStart() async {
        final class Counter: @unchecked Sendable {
            let lock = NSLock()
            var value = 0
            func increment() {
                lock.lock()
                value += 1
                lock.unlock()
            }
        }
        let counter = Counter()
        let watcher = IOKitDeviceChangeWatcher()
        watcher.onDevicesChanged = { counter.increment() }
        watcher.start()
        try? await Task.sleep(for: .milliseconds(400))
        watcher.stop()
        XCTAssertEqual(counter.value, 0)
    }

    func testKeyboardPreferenceRoundTrip() {
        let defaults = UserDefaults(suiteName: "rgbprompt.keyboard-pref.test")!
        defaults.removePersistentDomain(forName: "rgbprompt.keyboard-pref.test")
        XCTAssertNil(KeyboardPreference.load(defaults: defaults))
        KeyboardPreference.save("EVision Keyboard 320F:5000", defaults: defaults)
        XCTAssertEqual(KeyboardPreference.load(defaults: defaults), "EVision Keyboard 320F:5000")
        KeyboardPreference.save(nil, defaults: defaults)
        XCTAssertNil(KeyboardPreference.load(defaults: defaults))
    }


}
