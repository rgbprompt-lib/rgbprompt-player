import XCTest
import RGBPromptPlayerCore
@testable import PlayerKit

final class PlayerKitUnitTests: XCTestCase {
    func testABIVersionMatchesHeader() {
        XCTAssertEqual(rgbp_abi_version(), UInt32(RGBP_ABI_VERSION))
    }

    func testFailureCodeRoundTripsEveryHeaderConstant() {
        let expected: [(Int32, FailureCode)] = [
            (Int32(RGBP_ERR_INTERNAL), .internalError),
            (Int32(RGBP_ERR_UPDATE_REQUIRED), .updateRequired),
            (Int32(RGBP_ERR_DECODE_FAILED), .decodeFailed),
            (Int32(RGBP_ERR_LINK_UNAVAILABLE), .linkUnavailable),
            (Int32(RGBP_ERR_DRIVER_DECLINED), .driverDeclined),
            (Int32(RGBP_ERR_OPENRGB_UNREACHABLE), .openrgbUnreachable),
            (Int32(RGBP_ERR_DEVICE_LOST), .deviceLost),
            (Int32(RGBP_ERR_UNSUPPORTED_PACKAGE), .unsupportedPackage),
            (Int32(RGBP_ERR_INVALID_ARGUMENT), .invalidArgument),
            (Int32(RGBP_ERR_BUFFER_TOO_SMALL), .bufferTooSmall),
            (Int32(RGBP_ERR_NOT_SUPPORTED), .notSupported),
            (Int32(RGBP_ERR_BAD_URL), .badUrl),
        ]

        XCTAssertEqual(expected.count, FailureCode.allCases.count)
        for (code, failure) in expected {
            XCTAssertEqual(FailureCode(code: code), failure)
            XCTAssertEqual(failure.code, code)
            XCTAssertEqual(BridgeError.from(code: code), .failure(failure))
        }
        XCTAssertNil(BridgeError.from(code: Int32(RGBP_OK)))
    }

    func testPanelStateMappingTable() {
        XCTAssertEqual(PanelState.from(event(0)), .idle(failure: nil))
        XCTAssertEqual(
            PanelState.from(event(0, error: Int32(RGBP_ERR_DECODE_FAILED))),
            .idle(failure: .decodeFailed)
        )
        XCTAssertEqual(PanelState.from(event(1)), .preparing)
        XCTAssertEqual(PanelState.from(event(2, progress: 0)), .needsDriver(progress: 0, driverError: 0))
        XCTAssertEqual(PanelState.from(event(2, progress: -1)), .needsDriver(progress: nil, driverError: 0))
        XCTAssertEqual(PanelState.from(event(2, progress: 150)), .needsDriver(progress: 100, driverError: 0))
        XCTAssertEqual(
            PanelState.from(event(2, progress: 40, driverError: 4)),
            .needsDriver(progress: 40, driverError: 4)
        )
        XCTAssertEqual(
            PanelState.from(event(3, error: Int32(RGBP_ERR_DEVICE_LOST))),
            .noKeyboard(deviceLost: true)
        )
        XCTAssertEqual(PanelState.from(event(3)), .noKeyboard(deviceLost: false))
        XCTAssertEqual(PanelState.from(event(4)), .playing)
        XCTAssertEqual(PanelState.from(event(5)), .backendUnresponsive)
        XCTAssertEqual(
            PanelState.from(event(6, conflict: "Corsair iCUE")),
            .vendorConflict(name: "Corsair iCUE")
        )
        XCTAssertEqual(PanelState.from(event(6, conflict: "  ")), .vendorConflict(name: nil))
        XCTAssertEqual(PanelState.from(event(7)), .blocked)
        XCTAssertEqual(PanelState.from(event(99)), .coreUnavailable)
        XCTAssertEqual(PanelState.from(event(-1)), .coreUnavailable)
    }

    func testStatusBadgeMappingTable() {
        XCTAssertEqual(StatusBadge.from(.playing), .playing)
        XCTAssertEqual(StatusBadge.from(.idle(failure: nil)), .none)
        XCTAssertEqual(StatusBadge.from(.idle(failure: .decodeFailed)), .attention)
        XCTAssertEqual(StatusBadge.from(.preparing), .none)
        XCTAssertEqual(StatusBadge.from(.needsDriver(progress: nil, driverError: 0)), .attention)
        XCTAssertEqual(StatusBadge.from(.noKeyboard(deviceLost: false)), .attention)
        XCTAssertEqual(StatusBadge.from(.backendUnresponsive), .attention)
        XCTAssertEqual(StatusBadge.from(.vendorConflict(name: nil)), .attention)
        XCTAssertEqual(StatusBadge.from(.blocked), .attention)
        XCTAssertEqual(StatusBadge.from(.coreUnavailable), .attention)
    }

    func testEveryLocalizationKeyExistsInBothLanguages() throws {
        let bundle = PlayerKitResources.bundle
        for language in ["en", "zh-Hans"] {
            let lprojPath = try XCTUnwrap(
                bundle.path(forResource: language, ofType: "lproj"),
                "missing \(language).lproj in \(bundle.bundlePath)"
            )
            let lproj = try XCTUnwrap(Bundle(path: lprojPath))
            let stringsPath = try XCTUnwrap(lproj.path(forResource: "Localizable", ofType: "strings"))
            let data = try Data(contentsOf: URL(fileURLWithPath: stringsPath))
            let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
            let table = try XCTUnwrap(plist as? [String: String])

            for key in LocalizationKeys.all {
                XCTAssertNotNil(table[key], "\(language) is missing \(key)")
            }
        }
    }

    func testInfoPlistStringsCarryAudioUsageDescription() throws {
        let bundle = PlayerKitResources.bundle
        for language in ["en", "zh-Hans"] {
            let path = try XCTUnwrap(
                bundle.path(
                    forResource: "InfoPlist",
                    ofType: "strings",
                    inDirectory: nil,
                    forLocalization: language
                ),
                "missing \(language) InfoPlist.strings in \(bundle.bundlePath)"
            )
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
            let table = try XCTUnwrap(plist as? [String: String])
            XCTAssertNotNil(
                table["NSAudioCaptureUsageDescription"],
                "\(language) is missing NSAudioCaptureUsageDescription"
            )
        }
    }

    func testEntryPointClassification() {
        let playerURL = URL(string: "rgbprompt://play?t=abc&v=1")!
        XCTAssertEqual(EntryPoint.classify(playerURL), .playerURL(playerURL))

        let lepURL = URL(fileURLWithPath: "/tmp/effect.LEP")
        XCTAssertEqual(EntryPoint.classify(lepURL), .lepFile(lepURL))

        XCTAssertEqual(EntryPoint.classify(URL(fileURLWithPath: "/tmp/effect.txt")), .ignored)
        XCTAssertEqual(EntryPoint.classify(URL(string: "https://rgbprompt.com")!), .ignored)
    }

    func testEntryPointRevealsPanel() {
        // Only the explicit open host may reveal the panel; play/push and
        // .lep keep the current visibility.
        XCTAssertTrue(EntryPoint.playerURL(URL(string: "rgbprompt://open")!).revealsPanel)
        XCTAssertTrue(EntryPoint.playerURL(URL(string: "rgbprompt://OPEN")!).revealsPanel)
        XCTAssertFalse(EntryPoint.playerURL(URL(string: "rgbprompt://play?t=abc&v=1")!).revealsPanel)
        XCTAssertFalse(EntryPoint.playerURL(URL(string: "rgbprompt://token/xyz")!).revealsPanel)
        XCTAssertFalse(EntryPoint.lepFile(URL(fileURLWithPath: "/tmp/effect.lep")).revealsPanel)
        XCTAssertFalse(EntryPoint.ignored.revealsPanel)
    }

    func testLaunchArgumentParsing() {
        let playerURL = URL(string: "rgbprompt://open")!
        XCTAssertEqual(
            EntryPoint.fromLaunchArguments(["RGBPrompt Player", "rgbprompt://open"]),
            .playerURL(playerURL)
        )

        let path = "/tmp/effect.lep"
        XCTAssertEqual(
            EntryPoint.fromLaunchArguments(["RGBPrompt Player", path]),
            .lepFile(URL(fileURLWithPath: path).standardizedFileURL)
        )
        XCTAssertNil(EntryPoint.fromLaunchArguments(["RGBPrompt Player", "--verbose"]))
        XCTAssertNil(EntryPoint.fromLaunchArguments([]))
    }

    func testPlayerURLRedaction() {
        XCTAssertEqual(
            Redact.playerURL("rgbprompt://play?t=abcdef123456&v=1"),
            "rgbprompt://play?t=abcdef…"
        )
        XCTAssertEqual(Redact.playerURL("rgbprompt://open"), "rgbprompt://open?t=…")
        XCTAssertEqual(
            Redact.playerURL("rgbprompt://play?t=abc"),
            "rgbprompt://play?t=abc…"
        )
        XCTAssertEqual(Redact.playerURL("not a url"), "<invalid-url>")
    }

    func testStudioURLPointsAtAppRoute() {
        XCTAssertEqual(
            BridgeConfigBuilder.studioURL(apiBase: "https://rgbprompt.com/api")?.absoluteString,
            "https://rgbprompt.com/app"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.studioURL(apiBase: "http://127.0.0.1:5173/api")?.absoluteString,
            "http://127.0.0.1:5173/app"
        )
    }

    func testSiteOriginStripsAPI() {
        XCTAssertEqual(
            BridgeConfigBuilder.siteOrigin(apiBase: "https://rgbprompt.com/api")?.absoluteString,
            "https://rgbprompt.com"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.siteOrigin(apiBase: "http://127.0.0.1:8787/api")?.absoluteString,
            "http://127.0.0.1:8787"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.siteOrigin(apiBase: "https://rgbprompt.com/api/")?.absoluteString,
            "https://rgbprompt.com"
        )
    }

    func testOSVersionNormalization() {
        XCTAssertEqual(
            BridgeConfigBuilder.normalizeOSVersion("Version 14.2 (Build 23C64)"),
            "14.2.0"
        )
        XCTAssertEqual(BridgeConfigBuilder.normalizeOSVersion("macOS 14.2.1"), "14.2.1")
        XCTAssertEqual(BridgeConfigBuilder.normalizeOSVersion("27.2"), "27.2.0")
        XCTAssertEqual(BridgeConfigBuilder.normalizeOSVersion("unknown"), "0.0.0")
    }

    func testLanguageMapping() {
        XCTAssertEqual(BridgeConfigBuilder.language(preferredLanguages: ["zh-Hans-CN", "en"]), "zh-CN")
        XCTAssertEqual(BridgeConfigBuilder.language(preferredLanguages: ["zh-Hant"]), "zh-CN")
        XCTAssertEqual(BridgeConfigBuilder.language(preferredLanguages: ["en-US"]), "en")
        XCTAssertEqual(BridgeConfigBuilder.language(preferredLanguages: ["fr-FR", "zh-Hans"]), "en")
        XCTAssertEqual(BridgeConfigBuilder.language(preferredLanguages: []), "en")
    }

    func testConfigResolutionOrder() {
        XCTAssertEqual(
            BridgeConfigBuilder.resolveAPIBase(
                environment: ["RGBP_API_BASE": "http://env/api/"],
                defaults: "http://defaults/api",
                infoPlist: "http://info/api"
            ),
            "http://env/api"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.resolveAPIBase(
                environment: [:],
                defaults: "http://defaults/api",
                infoPlist: "http://info/api"
            ),
            "http://defaults/api"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.resolveAPIBase(
                environment: [:],
                defaults: nil,
                infoPlist: "http://info/api"
            ),
            "http://info/api"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.resolveAPIBase(environment: [:], defaults: nil, infoPlist: nil),
            BridgeConfigBuilder.productionAPIBase
        )

        XCTAssertEqual(
            BridgeConfigBuilder.resolveOpenRGBAddr(
                environment: ["RGBP_OPENRGB_ADDR": "127.0.0.1:7000"],
                defaults: "127.0.0.1:6742"
            ),
            "127.0.0.1:7000"
        )
        XCTAssertEqual(
            BridgeConfigBuilder.resolveOpenRGBAddr(environment: [:], defaults: "127.0.0.1:6742"),
            "127.0.0.1:6742"
        )
        XCTAssertNil(
            BridgeConfigBuilder.resolveOpenRGBAddr(environment: [:], defaults: nil)
        )
    }

    func testDriverInfoDecoding() throws {
        let json = #"{"variant":"standard","version":"1.0","sizeBytes":1234,"installDir":"/tmp/openrgb","source":"official","license":"GPL-2.0","installed":true,"mode":"external","port":6742,"executable":"/tmp/openrgb/OpenRGB"}"#
        let info = try JSONDecoder().decode(DriverInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.variant, "standard")
        XCTAssertEqual(info.version, "1.0")
        XCTAssertEqual(info.sizeBytes, 1234)
        XCTAssertEqual(info.installDir, "/tmp/openrgb")
        XCTAssertEqual(info.installed, true)
        XCTAssertEqual(info.port, 6742)
    }

    func testKeyLayoutHas104NonOverlappingKeys() {
        XCTAssertEqual(KeyLayout.keys.count, 104)
        XCTAssertEqual(Set(KeyLayout.keys.map(\.name)).count, 104)

        for first in 0..<KeyLayout.keys.count {
            for second in (first + 1)..<KeyLayout.keys.count {
                let a = KeyLayout.keys[first]
                let b = KeyLayout.keys[second]
                let overlaps = a.x < b.x + b.w
                    && b.x < a.x + a.w
                    && a.y < b.y + b.h
                    && b.y < a.y + a.h
                XCTAssertFalse(overlaps, "\(a.name) overlaps \(b.name)")
            }
        }
    }

    private func event(
        _ state: Int32,
        error: Int32 = 0,
        progress: Int32 = -1,
        driverError: Int32 = 0,
        conflict: String? = nil
    ) -> CoreStateEvent {
        CoreStateEvent(
            state: state,
            error: error,
            driverProgress: progress,
            driverError: driverError,
            conflictName: conflict
        )
    }

    func testLaunchEntryQueueHoldsUrlUntilStart() {
        var delivered: [EntryPoint] = []
        let queue = LaunchEntryQueue { delivered.append($0) }
        let url = URL(string: "rgbprompt://play?t=abc&v=1")!
        queue.submit(.playerURL(url))
        XCTAssertEqual(queue.pendingCount, 1)
        XCTAssertTrue(delivered.isEmpty)
        queue.start()
        XCTAssertEqual(delivered, [.playerURL(url)])
        XCTAssertEqual(queue.pendingCount, 0)
    }

    func testLaunchEntryQueueDropsDuplicateColdStartUrl() {
        var delivered: [EntryPoint] = []
        let queue = LaunchEntryQueue { delivered.append($0) }
        let url = URL(string: "rgbprompt://play?t=abc&v=1")!
        queue.submit(.playerURL(url))
        queue.submit(.playerURL(url))
        queue.submit(.playerURL(url))
        queue.start()
        // argv + GetURL + application(_:open:) must not play the same link twice.
        XCTAssertEqual(delivered, [.playerURL(url)])
    }

    func testLaunchEntryQueueDeliversAfterStartAndSkipsImmediateRepeat() {
        var delivered: [EntryPoint] = []
        let queue = LaunchEntryQueue { delivered.append($0) }
        queue.start()
        let first = URL(string: "rgbprompt://play?t=aaa&v=1")!
        let second = URL(string: "rgbprompt://play?t=bbb&v=1")!
        queue.submit(.playerURL(first))
        queue.submit(.playerURL(first))
        queue.submit(.playerURL(second))
        XCTAssertEqual(delivered, [.playerURL(first), .playerURL(second)])
    }

    func testLaunchEntryQueueIgnoresIgnoredAndKeepsFirstPending() {
        var delivered: [EntryPoint] = []
        let queue = LaunchEntryQueue { delivered.append($0) }
        queue.submit(.ignored)
        let first = URL(string: "rgbprompt://play?t=first&v=1")!
        let later = URL(string: "rgbprompt://play?t=later&v=1")!
        queue.submit(.playerURL(first))
        queue.submit(.playerURL(later))
        queue.start()
        XCTAssertEqual(delivered, [.playerURL(first), .playerURL(later)])
    }
}
