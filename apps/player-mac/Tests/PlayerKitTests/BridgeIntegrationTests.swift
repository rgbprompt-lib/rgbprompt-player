import Combine
import CryptoKit
import Darwin
import Foundation
import Network
import RGBPromptPlayerCore
import XCTest
@testable import PlayerKit

@MainActor
final class BridgeIntegrationTests: XCTestCase {
    private var process: Process?
    private var dataDir: URL?
    private var bridge: PlayerCoreBridge?
    private var cancellables = Set<AnyCancellable>()

    deinit {
        process?.terminate()
    }

    override func tearDown() async throws {
        cancellables.removeAll()
        bridge?.shutdown()
        bridge = nil

        if let process {
            if process.isRunning {
                process.terminate()
                process.waitUntilExit()
            }
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        process = nil

        if let dataDir {
            try? FileManager.default.removeItem(at: dataDir)
        }
        dataDir = nil

        try await super.tearDown()
    }

    func testCoreEndToEndWithOpenRGBStub() async throws {
        let environment = ProcessInfo.processInfo.environment
        let relevant = environment.keys
            .filter { $0.contains("RGBP") || $0.contains("TEST_RUNNER") }
            .sorted()
            .joined(separator: ", ")
        let info = Bundle(for: BridgeIntegrationTests.self)
        let plistStub = info.object(forInfoDictionaryKey: "RGBPStubPath") as? String
        let plistLep = info.object(forInfoDictionaryKey: "RGBPLepPath") as? String
        let stubPath = try XCTUnwrap(
            environment["RGBP_STUB"]
                ?? environment["TEST_RUNNER_RGBP_STUB"]
                ?? plistStub,
            "RGBP_STUB not set; run pnpm player:mac:test (env: \(relevant))"
        )
        let lepPath = try XCTUnwrap(
            environment["RGBP_LEP"]
                ?? environment["TEST_RUNNER_RGBP_LEP"]
                ?? plistLep,
            "RGBP_LEP not set; run pnpm player:mac:test (env: \(relevant))"
        )

        let (stub, port) = try startStub(path: stubPath)
        process = stub

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rgbprompt-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        dataDir = tempDirectory

        let config = BridgeConfig(
            dataDir: tempDirectory.path,
            apiBase: "http://127.0.0.1:1/api",
            language: "en",
            appVersion: "0.3.0",
            osVersion: "14.2.0",
            openrgbAddr: "127.0.0.1:\(port)"
        )
        let bridge = PlayerCoreBridge(config: config)
        self.bridge = bridge

        XCTAssertTrue(Thread.isMainThread, "test method is not on the main thread")
        var observedStates: [PanelState] = []
        var offMainThreads: [String] = []
        bridge.$state
            .dropFirst()
            .sink { state in
                if !Thread.isMainThread {
                    offMainThreads.append(Thread.current.description)
                }
                observedStates.append(state)
            }
            .store(in: &cancellables)

        XCTAssertNil(bridge.openLepFile(lepPath))
        let reachedPlaying = await waitUntil(timeout: 5) { bridge.state == .playing }
        XCTAssertTrue(reachedPlaying, "never reached Playing; states: \(observedStates)")
        XCTAssertTrue(offMainThreads.isEmpty, "state updates off the main thread: \(offMainThreads)")
        // The core reports no effect name for local files (service.rs
        // open_lep_file); the bridge falls back to the file name.
        XCTAssertEqual(
            bridge.effectName,
            URL(fileURLWithPath: lepPath).deletingPathExtension().lastPathComponent
        )

        let poller = PreviewPoller(bridge: bridge)
        let first = poller.pollOnce()
        XCTAssertNotNil(first)
        try await Task.sleep(for: .milliseconds(180))
        let second = poller.pollOnce()
        XCTAssertEqual(second?.rgb.count, 104 * 3)
        XCTAssertGreaterThan(second?.seq ?? -1, first?.seq ?? -1)

        let diagnostics = try XCTUnwrap(bridge.diagnosticsJSON())
        let object = try JSONSerialization.jsonObject(with: Data(diagnostics.utf8))
        let dictionary = try XCTUnwrap(object as? [String: Any])
        XCTAssertEqual(dictionary["schema"] as? Int, 1)

        XCTAssertFalse(bridge.stoppedByUser)
        XCTAssertNil(bridge.stop())
        XCTAssertTrue(bridge.stoppedByUser, "stopping a playing effect shows the replug hint")
        let returnedToIdle = await waitUntil(timeout: 3) { bridge.state == .idle(failure: nil) }
        XCTAssertTrue(returnedToIdle, "never returned to Idle; states: \(observedStates)")
        XCTAssertTrue(bridge.stoppedByUser, "the hint stays while Idle")

        let garbage = tempDirectory.appendingPathComponent("garbage.lep")
        try Data([0x00, 0x01, 0x02, 0xFF]).write(to: garbage)
        XCTAssertNil(bridge.openLepFile(garbage.path))
        XCTAssertFalse(bridge.stoppedByUser, "a new play clears the replug hint")
        let rejectedGarbage = await waitUntil(timeout: 5) {
            bridge.state == .idle(failure: .decodeFailed)
        }
        XCTAssertTrue(
            rejectedGarbage,
            "garbage .lep did not yield decodeFailed; states: \(observedStates)"
        )
    }

    func testInputWantsAndPushThroughStub() async throws {
        let environment = ProcessInfo.processInfo.environment
        let info = Bundle(for: BridgeIntegrationTests.self)
        let plistStub = info.object(forInfoDictionaryKey: "RGBPStubPath") as? String
        let plistLep = info.object(forInfoDictionaryKey: "RGBPLepPath") as? String
        let stubPath = try XCTUnwrap(
            environment["RGBP_STUB"] ?? environment["TEST_RUNNER_RGBP_STUB"] ?? plistStub
        )
        let lepPath = try XCTUnwrap(
            environment["RGBP_LEP"] ?? environment["TEST_RUNNER_RGBP_LEP"] ?? plistLep
        )
        let fixtureDirectory = URL(fileURLWithPath: lepPath).deletingLastPathComponent()

        let (stub, port) = try startStub(path: stubPath)
        process = stub

        let tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rgbprompt-input-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
        dataDir = tempDirectory

        let config = BridgeConfig(
            dataDir: tempDirectory.path,
            apiBase: "http://127.0.0.1:1/api",
            language: "en",
            appVersion: "0.3.0",
            osVersion: "14.2.0",
            openrgbAddr: "127.0.0.1:\(port)"
        )
        let bridge = PlayerCoreBridge(config: config)
        self.bridge = bridge

        XCTAssertNil(bridge.openLepFile(lepPath))
        let reachedPlaying = await waitUntil(timeout: 5) { bridge.state == .playing }
        XCTAssertTrue(reachedPlaying)
        XCTAssertEqual(bridge.inputWanted(), [])

        XCTAssertNil(bridge.stop())
        let returnedToIdle = await waitUntil(timeout: 3) { bridge.state == .idle(failure: nil) }
        XCTAssertTrue(returnedToIdle)
        XCTAssertEqual(bridge.inputWanted(), [])

        let party = fixtureDirectory.appendingPathComponent("party.lep").path
        XCTAssertNil(bridge.openLepFile(party))
        let partyPlaying = await waitUntil(timeout: 5) { bridge.state == .playing }
        XCTAssertTrue(partyPlaying)
        XCTAssertEqual(bridge.inputWanted(), [.audio, .keys])

        XCTAssertEqual(bridge.pushKey("A", down: true), 0)
        XCTAssertEqual(bridge.pushKey("A", down: false), 0)
        XCTAssertEqual(bridge.pushKey("NOT_A_KEY", down: true), 0)

        let samples = [Float](repeating: 0.1, count: 2_048)
        let audioResult = samples.withUnsafeBufferPointer { buffer in
            bridge.pushAudio(buffer, frames: 1_024, channels: 2, sampleRate: 48_000)
        }
        XCTAssertEqual(audioResult, 0)

        let zeroFrames = samples.withUnsafeBufferPointer { buffer in
            bridge.pushAudio(buffer, frames: 0, channels: 2, sampleRate: 48_000)
        }
        XCTAssertEqual(zeroFrames, Int32(RGBP_ERR_INVALID_ARGUMENT))

        XCTAssertNil(bridge.stop())
        let stoppedParty = await waitUntil(timeout: 3) { bridge.state == .idle(failure: nil) }
        XCTAssertTrue(stoppedParty)
        XCTAssertEqual(bridge.inputWanted(), [])

        let music = fixtureDirectory.appendingPathComponent("music-spectrum.lep").path
        XCTAssertNil(bridge.openLepFile(music))
        let musicPlaying = await waitUntil(timeout: 5) { bridge.state == .playing }
        XCTAssertTrue(musicPlaying)
        XCTAssertEqual(bridge.inputWanted(), [.audio])
    }

    private func startStub(path: String) throws -> (Process, Int) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = ["--port", "0", "--preset", "per-key", "--protocol", "3"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()
        do {
            let port = try readPort(from: pipe.fileHandleForReading, process: process)
            return (process, port)
        } catch {
            process.terminate()
            throw error
        }
    }

    private func readPort(from handle: FileHandle, process: Process) throws -> Int {
        let regex = try NSRegularExpression(pattern: "127\\.0\\.0\\.1:([0-9]+)")
        var buffer = Data()
        let deadline = Date().addingTimeInterval(5)

        while Date() < deadline {
            let chunk = handle.availableData
            if chunk.isEmpty {
                if !process.isRunning { break }
                continue
            }
            buffer.append(chunk)
            if let text = String(data: buffer, encoding: .utf8),
               let match = regex.firstMatch(
                   in: text,
                   range: NSRange(text.startIndex..<text.endIndex, in: text)
               ),
               let range = Range(match.range(at: 1), in: text),
               let port = Int(text[range]) {
                return port
            }
        }
        throw StubError.noPort
    }

    private func waitUntil(
        timeout: TimeInterval,
        _ predicate: @escaping @MainActor () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return predicate()
    }
}


// MARK: - Driver install / supervision integration

extension BridgeIntegrationTests {
    private func fixture(stub stubPath: String, lep lepPath: String) -> (String, String) {
        (stubPath, lepPath)
    }

    private func fixturePaths() throws -> (stub: String, lep: String) {
        let environment = ProcessInfo.processInfo.environment
        let info = Bundle(for: BridgeIntegrationTests.self)
        let plistStub = info.object(forInfoDictionaryKey: "RGBPStubPath") as? String
        let plistLep = info.object(forInfoDictionaryKey: "RGBPLepPath") as? String
        let stubPath = try XCTUnwrap(
            environment["RGBP_STUB"] ?? environment["TEST_RUNNER_RGBP_STUB"] ?? plistStub
        )
        let lepPath = try XCTUnwrap(
            environment["RGBP_LEP"] ?? environment["TEST_RUNNER_RGBP_LEP"] ?? plistLep
        )
        return (stubPath, lepPath)
    }

    private func makeTempDir(_ prefix: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private func manifestJSON(
        url: String,
        sha256: String?,
        size: Int,
        executable: String = "OpenRGB.app/Contents/MacOS/OpenRGB",
        version: String = "9.9"
    ) -> String {
        let urls = [["kind": "official", "url": url]]
        let object: [String: Any] = [
            "schema": 1,
            "variant": "standard",
            "version": version,
            "platform": "macos",
            "arch": "arm64",
            "archive": "zip",
            "size_bytes": size,
            "sha256": sha256 as Any,
            "executable": executable,
            "args": ["--server", "--server-port", "{port}"],
            "urls": urls,
            "license": "GPL-2.0-only",
            "source": "https://openrgb.org",
        ]
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private func config(
        dataDir: URL,
        openrgbAddr: String
    ) -> BridgeConfig {
        BridgeConfig(
            dataDir: dataDir.path,
            apiBase: "http://127.0.0.1:1/api",
            language: "en",
            appVersion: "0.3.0",
            osVersion: "14.2.0",
            openrgbAddr: openrgbAddr
        )
    }

    func testBuiltInManifestFailsClosed() async throws {
        let (_, lepPath) = try fixturePaths()
        let tempDirectory = try makeTempDir("rgbprompt-builtin")
        dataDir = tempDirectory
        let bridge = PlayerCoreBridge(
            config: config(
                dataDir: tempDirectory,
                openrgbAddr: "127.0.0.1:\(FreePort.next())"
            )
        )
        self.bridge = bridge

        XCTAssertNil(bridge.openLepFile(lepPath))
        let needsDriver = await waitUntil(timeout: 5) {
            if case .needsDriver(_, 0) = bridge.state { return true }
            return false
        }
        XCTAssertTrue(needsDriver, "states: \(bridge.state)")
        XCTAssertFalse(bridge.driverInfo?.isVerified ?? true)
        XCTAssertEqual(bridge.installDriver(), .failure(.notSupported))
        let unverified = await waitUntil(timeout: 5) {
            if case .needsDriver(_, 5) = bridge.state { return true }
            return false
        }
        XCTAssertTrue(unverified, "driver_error must be 5; state: \(bridge.state)")
    }

    func testOverrideInstallsPlaysAndSupervisesRestart() async throws {
        let (stubPath, lepPath) = try fixturePaths()
        let tempDirectory = try makeTempDir("rgbprompt-override")
        dataDir = tempDirectory

        let stub = try Data(contentsOf: URL(fileURLWithPath: stubPath))
        let archive = ZipArchive.singleFile(
            path: "OpenRGB.app/Contents/MacOS/OpenRGB",
            data: stub,
            mode: 0o755
        )
        let server = try LoopbackFileServer(body: archive)
        defer { server.stop() }

        // The managed launcher starts at the configured port, so a private
        // port keeps the test away from the user's OpenRGB on 6742.
        let managedPort = FreePort.next()

        let bridge = PlayerCoreBridge(
            config: config(
                dataDir: tempDirectory,
                openrgbAddr: "127.0.0.1:\(managedPort)"
            )
        )
        self.bridge = bridge

        let json = manifestJSON(
            url: server.url,
            sha256: ZipArchive.sha256Hex(archive),
            size: archive.count
        )
        XCTAssertNil(bridge.setDriverManifest(json: json))
        XCTAssertTrue(bridge.driverInfo?.isVerified ?? false)

        var progress: [Int] = []
        bridge.$driverProgress
            .compactMap { $0 }
            .sink { progress.append($0) }
            .store(in: &cancellables)
        var supervision: [String] = []
        bridge.$driverInfo
            .compactMap { $0?.supervision?.state }
            .sink { supervision.append($0) }
            .store(in: &cancellables)

        XCTAssertNil(bridge.openLepFile(lepPath))
        let needsDriver = await waitUntil(timeout: 5) {
            if case .needsDriver = bridge.state { return true }
            return false
        }
        XCTAssertTrue(needsDriver)
        XCTAssertNil(bridge.installDriver())
        let playing = await waitUntil(timeout: 15) { bridge.state == .playing }
        XCTAssertTrue(playing, "state: \(bridge.state)")
        XCTAssertEqual(bridge.driverInfo?.mode, "managed")
        XCTAssertTrue(progress.contains(100), "progress: \(progress)")
        XCTAssertTrue(
            zip(progress, progress.dropFirst()).allSatisfy { $0 <= $1 },
            "progress must not decrease: \(progress)"
        )

        // The supervisor treats a SIGKILL in the first 2 s as AMFI blocking,
        // not a crash; let the process outlive that window first.
        try await Task.sleep(for: .seconds(2.2))
        let pid = try XCTUnwrap(ManagedStub.pid(dataDir: tempDirectory))
        XCTAssertEqual(kill(pid, SIGKILL), 0)
        // Supervisor may relaunch before the shell samples "restarting"; either
        // seeing that state or recovering to Playing+running counts as success.
        let sawRestarting = await waitUntil(timeout: 5) {
            bridge.driverInfo?.supervision?.state == "restarting"
                || supervision.contains("restarting")
        }
        let resumed = await waitUntil(timeout: 10) {
            bridge.state == .playing && bridge.driverInfo?.supervision?.state == "running"
        }
        XCTAssertTrue(
            sawRestarting || resumed,
            "expected restarting or recovered running; supervision: \(supervision) state: \(bridge.state)"
        )
        XCTAssertTrue(resumed, "supervision: \(supervision)")

        XCTAssertNil(bridge.stop())
        _ = await waitUntil(timeout: 3) { bridge.state == .idle(failure: nil) }
    }

    func testOverrideChecksumMismatchDeletesThePart() async throws {
        let (_, lepPath) = try fixturePaths()
        let tempDirectory = try makeTempDir("rgbprompt-checksum")
        dataDir = tempDirectory

        let archive = ZipArchive.singleFile(
            path: "OpenRGB.app/Contents/MacOS/OpenRGB",
            data: Data(repeating: 0x41, count: 256),
            mode: 0o755
        )
        let server = try LoopbackFileServer(body: archive)
        defer { server.stop() }
        // The managed launcher starts at the configured port, so a private
        // port keeps the test away from the user's OpenRGB on 6742.
        let managedPort = FreePort.next()

        let bridge = PlayerCoreBridge(
            config: config(
                dataDir: tempDirectory,
                openrgbAddr: "127.0.0.1:\(managedPort)"
            )
        )
        self.bridge = bridge
        let wrongSha = String(repeating: "0", count: 64)
        XCTAssertNil(
            bridge.setDriverManifest(
                json: manifestJSON(url: server.url, sha256: wrongSha, size: archive.count)
            )
        )
        XCTAssertNil(bridge.openLepFile(lepPath))
        _ = await waitUntil(timeout: 5) {
            if case .needsDriver = bridge.state { return true }
            return false
        }
        XCTAssertNil(bridge.installDriver())
        let mismatch = await waitUntil(timeout: 10) {
            if case .needsDriver(_, 2) = bridge.state { return true }
            return false
        }
        XCTAssertTrue(mismatch, "state: \(bridge.state)")

        let download = tempDirectory
            .appendingPathComponent("openrgb", isDirectory: true)
            .appendingPathComponent(".download", isDirectory: true)
        let files = (try? FileManager.default.contentsOfDirectory(atPath: download.path)) ?? []
        XCTAssertTrue(files.isEmpty, "part files left behind: \(files)")
    }
}

private enum FreePort {
    static func next() -> Int {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return 0 }
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, length)
            }
        }
        guard bound == 0 else {
            close(descriptor)
            return 0
        }
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(descriptor, $0, &length)
            }
        }
        close(descriptor)
        return Int(UInt16(bigEndian: address.sin_port))
    }
}

private enum ManagedStub {
    static func pid(dataDir: URL) -> pid_t? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        process.arguments = ["-f", dataDir.appendingPathComponent("openrgb").path]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(decoding: data, as: UTF8.self)
        guard let first = text.split(separator: "\n").first, let pid = pid_t(first) else {
            return nil
        }
        return pid
    }
}

private final class LoopbackFileServer {
    let port: UInt16
    private let listener: NWListener
    private let body: Data
    private let queue = DispatchQueue(label: "com.rgbprompt.player.tests.file-server")

    var url: String { "http://127.0.0.1:\(port)/openrgb.zip" }

    init(body: Data) throws {
        self.body = body
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        let box = PortBox()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                box.port = listener.port?.rawValue ?? 0
                ready.signal()
            case .failed, .cancelled:
                ready.signal()
            default:
                break
            }
        }
        let body = self.body
        let queue = self.queue
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                let header = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                var payload = Data(header.utf8)
                payload.append(body)
                connection.send(content: payload, completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, box.port != 0 else {
            listener.cancel()
            throw StubError.noPort
        }
        self.listener = listener
        self.port = box.port
    }

    func stop() {
        listener.cancel()
    }
}

private final class PortBox: @unchecked Sendable {
    var port: UInt16 = 0
}

private enum ZipArchive {
    static func singleFile(path: String, data: Data, mode: UInt16) -> Data {
        let name = Data(path.utf8)
        let crc = crc32(data)
        var output = Data()
        var central = Data()

        appendU32(&output, 0x0403_4b50)
        appendU16(&output, 20)
        appendU16(&output, 0)
        appendU16(&output, 0)
        appendU16(&output, 0)
        appendU16(&output, 0)
        appendU32(&output, crc)
        appendU32(&output, UInt32(data.count))
        appendU32(&output, UInt32(data.count))
        appendU16(&output, UInt16(name.count))
        appendU16(&output, 0)
        output.append(name)
        output.append(data)

        let offset = UInt32(output.count - data.count - name.count - 30)
        appendU32(&central, 0x0201_4b50)
        appendU16(&central, 0x0314)
        appendU16(&central, 20)
        appendU16(&central, 0)
        appendU16(&central, 0)
        appendU16(&central, 0)
        appendU16(&central, 0)
        appendU32(&central, crc)
        appendU32(&central, UInt32(data.count))
        appendU32(&central, UInt32(data.count))
        appendU16(&central, UInt16(name.count))
        appendU16(&central, 0)
        appendU16(&central, 0)
        appendU16(&central, 0)
        appendU16(&central, 0)
        appendU32(&central, UInt32(mode & 0xFFFF) << 16)
        appendU32(&central, offset)
        central.append(name)

        let centralOffset = UInt32(output.count)
        output.append(central)
        appendU32(&output, 0x0605_4b50)
        appendU16(&output, 0)
        appendU16(&output, 0)
        appendU16(&output, 1)
        appendU16(&output, 1)
        appendU32(&output, UInt32(central.count))
        appendU32(&output, centralOffset)
        appendU16(&output, 0)
        return output
    }

    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func appendU16(_ data: inout Data, _ value: UInt16) {
        var little = value.littleEndian
        withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }

    private static func appendU32(_ data: inout Data, _ value: UInt32) {
        var little = value.littleEndian
        withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
    }

    private static let crcTable: [UInt32] = (0..<256).map { index in
        var value = UInt32(index)
        for _ in 0..<8 {
            value = (value & 1) != 0 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1
        }
        return value
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var value = UInt32.max
        for byte in data {
            value = crcTable[Int((value ^ UInt32(byte)) & 0xFF)] ^ (value >> 8)
        }
        return value ^ UInt32.max
    }
}

private enum StubError: Error {
    case noPort
}
