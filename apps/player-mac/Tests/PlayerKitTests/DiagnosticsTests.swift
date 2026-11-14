import Foundation
import XCTest
@testable import PlayerKit

@MainActor
final class DiagnosticsTests: XCTestCase {
    private func config() -> BridgeConfig {
        BridgeConfig(
            dataDir: NSTemporaryDirectory(),
            apiBase: "https://rgbprompt.com/api",
            language: "en",
            appVersion: "0.3.0",
            osVersion: "14.2.0",
            openrgbAddr: nil
        )
    }

    private func topLevelKeys(_ json: String) throws -> Set<String> {
        let data = try XCTUnwrap(json.data(using: .utf8))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        return Set(object.keys)
    }

    func testCoreJSONIsPrettyPrintedWithoutAddingKeys() throws {
        let source = FakeSource(
            json: #"{"schema":1,"playerVersion":"0.3.0","platform":"macos","osVersion":"14.2.0","engineVersion":"1.0.0","openrgb":null,"protocolRegistered":true,"devices":[],"recentErrors":[]}"#
        )
        let pasteboard = FakePasteboard()
        let copier = DiagnosticsCopier(
            source: source,
            config: config(),
            protocolRegistered: true,
            pasteboard: pasteboard
        )

        XCTAssertTrue(copier.copy())

        let copied = try XCTUnwrap(pasteboard.value)
        XCTAssertTrue(copied.contains("\n"), "pretty printed")
        let keys = try topLevelKeys(copied)
        XCTAssertEqual(keys, DiagnosticsCopier.allowedTopLevelKeys)
        XCTAssertTrue(keys.isSubset(of: DiagnosticsCopier.allowedTopLevelKeys))
    }

    func testFallbackUsesOnlyAllowedKeys() throws {
        let source = FakeSource(json: nil)
        let pasteboard = FakePasteboard()
        let copier = DiagnosticsCopier(
            source: source,
            config: config(),
            protocolRegistered: false,
            pasteboard: pasteboard
        )

        XCTAssertTrue(copier.copy())

        let copied = try XCTUnwrap(pasteboard.value)
        let keys = try topLevelKeys(copied)
        XCTAssertEqual(
            keys,
            ["schema", "playerVersion", "platform", "osVersion", "protocolRegistered"]
        )
        XCTAssertTrue(keys.isSubset(of: DiagnosticsCopier.allowedTopLevelKeys))
        XCTAssertTrue(copied.contains("\"platform\" : \"macos\""))
        XCTAssertTrue(copied.contains("\"protocolRegistered\" : false"))
        XCTAssertTrue(copied.contains("\"playerVersion\" : \"0.3.0\""))
    }

    func testPasteboardFailureIsReported() {
        let pasteboard = FakePasteboard()
        pasteboard.succeeds = false
        let copier = DiagnosticsCopier(
            source: FakeSource(json: "{}"),
            config: config(),
            protocolRegistered: true,
            pasteboard: pasteboard
        )
        XCTAssertFalse(copier.copy())
    }

    private final class FakeSource: DiagnosticsSource {
        let json: String?

        init(json: String?) {
            self.json = json
        }

        func diagnosticsJSON() -> String? {
            json
        }
    }

    private final class FakePasteboard: DiagnosticsPasteboard {
        var value: String?
        var succeeds = true

        func setString(_ value: String) -> Bool {
            guard succeeds else { return false }
            self.value = value
            return true
        }
    }
}
