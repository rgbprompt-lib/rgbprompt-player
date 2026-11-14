import XCTest
@testable import PlayerKit

@MainActor
final class InputCoordinatorTests: XCTestCase {
    nonisolated(unsafe) private var suites: [String] = []

    override func tearDown() {
        for suite in suites {
            UserDefaults.standard.removePersistentDomain(forName: suite)
        }
        suites.removeAll()
        super.tearDown()
    }

    // MARK: - Capture lifecycle

    func testInstallAndUninstallFollowStateAndWantedBits() {
        let fixture = make()
        fixture.bridge.wanted = [.audio, .keys]

        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.keys.startCount, 1)
        XCTAssertEqual(fixture.audio.startCount, 1)
        XCTAssertTrue(fixture.coordinator.audioWanted)

        fixture.coordinator.update(state: .noKeyboard(deviceLost: true))
        XCTAssertEqual(fixture.keys.stopCount, 1)
        XCTAssertEqual(fixture.audio.stopCount, 1)
        XCTAssertFalse(fixture.coordinator.audioWanted)

        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.keys.startCount, 2)
        XCTAssertEqual(fixture.audio.startCount, 2)

        fixture.coordinator.update(state: .idle(failure: nil))
        XCTAssertEqual(fixture.keys.stopCount, 2)
        XCTAssertEqual(fixture.audio.stopCount, 2)
    }

    func testNewEffectWithDifferentWantedBitsSwapsCaptures() {
        let fixture = make()
        fixture.bridge.wanted = [.audio]
        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.keys.startCount, 0)
        XCTAssertEqual(fixture.audio.startCount, 1)

        fixture.bridge.wanted = [.keys]
        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.audio.stopCount, 1)
        XCTAssertEqual(fixture.keys.startCount, 1)

        fixture.bridge.wanted = []
        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.keys.stopCount, 1)
    }

    func testDisabledEnvironmentTurnsBothOff() {
        let fixture = make(environment: [InputSettings.disableCaptureEnvironment: "1"])
        fixture.bridge.wanted = [.audio, .keys]
        fixture.coordinator.update(state: .playing)

        XCTAssertEqual(fixture.keys.startCount, 0)
        XCTAssertEqual(fixture.audio.startCount, 0)
        XCTAssertFalse(fixture.coordinator.audioWanted)
        XCTAssertNil(fixture.coordinator.keyNotice)
        XCTAssertNil(fixture.coordinator.audioNotice)
    }

    // MARK: - Key permission flow

    func testExplanationContinueInstallsCapture() {
        let fixture = make(auth: .notDetermined)
        var shown = 0
        fixture.coordinator.onShowPanel = { shown += 1 }
        fixture.bridge.wanted = [.keys]

        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.coordinator.keyNotice, .explain)
        XCTAssertEqual(shown, 1)
        XCTAssertEqual(fixture.keys.startCount, 0)
        XCTAssertEqual(fixture.keys.authorizationRequests, 0)

        fixture.keys.grantOnRequest = true
        fixture.coordinator.continueAfterKeyExplanation()

        XCTAssertEqual(fixture.keys.authorizationRequests, 1)
        XCTAssertEqual(fixture.keys.startCount, 1)
        XCTAssertNil(fixture.coordinator.keyNotice)
        XCTAssertTrue(fixture.defaults.bool(forKey: InputSettings.keyInputExplained))
    }

    func testNotNowSkipsPromptAndShowsDenied() {
        let fixture = make(auth: .notDetermined)
        fixture.bridge.wanted = [.keys]
        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.coordinator.keyNotice, .explain)

        fixture.coordinator.notNowKeyExplanation()

        XCTAssertEqual(fixture.coordinator.keyNotice, .denied)
        XCTAssertEqual(fixture.keys.authorizationRequests, 0)
        XCTAssertEqual(fixture.keys.startCount, 0)
        XCTAssertTrue(fixture.defaults.bool(forKey: InputSettings.keyInputExplained))
    }

    func testDeniedNoticeInstallsAfterTwoSecondRecheck() {
        let fixture = make(auth: .denied)
        fixture.defaults.set(true, forKey: InputSettings.keyInputExplained)
        fixture.bridge.wanted = [.keys]

        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.coordinator.keyNotice, .denied)
        XCTAssertEqual(fixture.keys.startCount, 0)

        fixture.keys.auth = .granted
        fixture.clock.advance(1)
        fixture.scheduler.fire()
        XCTAssertEqual(fixture.keys.startCount, 0, "rechecked before two seconds")

        fixture.clock.advance(1)
        fixture.scheduler.fire()
        XCTAssertEqual(fixture.keys.startCount, 1)
        XCTAssertNil(fixture.coordinator.keyNotice)
    }

    func testFailedTapStartNeedsRelaunch() {
        let fixture = make(auth: .granted, keyStartResult: false)
        fixture.bridge.wanted = [.keys]

        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.keys.startCount, 1)
        XCTAssertEqual(fixture.coordinator.keyNotice, .needsRelaunch)
        XCTAssertFalse(fixture.coordinator.audioWanted)
    }

    func testKeyPushGoesToInjectedSink() {
        let fixture = make(auth: .granted)
        fixture.bridge.wanted = [.keys]
        fixture.coordinator.update(state: .playing)

        fixture.keys.onKey?("A", true)
        fixture.keys.onKey?("A", false)

        XCTAssertEqual(fixture.bridge.keySink.events.map(\.name), ["A", "A"])
        XCTAssertEqual(fixture.bridge.keySink.events.map(\.down), [true, false])
    }

    // MARK: - Audio flow

    func testAudioOffDoesNotWantAudioEvenWhenTheEffectDoes() {
        let fixture = make()
        fixture.bridge.wanted = [.audio, .keys]
        fixture.coordinator.setAudioEnabled(false)

        fixture.coordinator.update(state: .playing)

        XCTAssertEqual(fixture.audio.startCount, 0)
        XCTAssertFalse(fixture.coordinator.audioWanted)
        XCTAssertEqual(fixture.keys.startCount, 1, "key capture is unaffected")

        fixture.coordinator.setAudioEnabled(true)
        XCTAssertEqual(fixture.audio.startCount, 1)

        fixture.coordinator.setAudioEnabled(false)
        XCTAssertEqual(fixture.audio.stopCount, 1)
        XCTAssertFalse(fixture.coordinator.audioWanted)
        XCTAssertNil(fixture.coordinator.audioNotice)
    }

    func testAudioStartFailureShowsUnavailable() {
        let fixture = make()
        fixture.audio.startResult = .failed(-50)
        fixture.bridge.wanted = [.audio]

        fixture.coordinator.update(state: .playing)
        XCTAssertEqual(fixture.coordinator.audioNotice, .unavailable)
    }

    func testThreeSecondsOfZerosWhileOthersPlayShowsLikelyDenied() {
        let fixture = make()
        fixture.audio.othersPlaying = true
        fixture.bridge.wanted = [.audio]

        fixture.coordinator.update(state: .playing)
        XCTAssertNil(fixture.coordinator.audioNotice)

        fixture.clock.advance(3)
        fixture.scheduler.fire()
        XCTAssertEqual(fixture.coordinator.audioNotice, .likelyDenied)
    }

    func testZerosWhileNothingElsePlaysDoNotShowNotice() {
        let fixture = make()
        fixture.audio.othersPlaying = false
        fixture.bridge.wanted = [.audio]

        fixture.coordinator.update(state: .playing)
        fixture.clock.advance(5)
        fixture.scheduler.fire()
        XCTAssertNil(fixture.coordinator.audioNotice)
    }

    func testNonZeroAudioClearsLikelyDeniedAndReachesSink() {
        let fixture = make()
        fixture.audio.othersPlaying = true
        fixture.bridge.wanted = [.audio]

        fixture.coordinator.update(state: .playing)
        fixture.clock.advance(3)
        fixture.scheduler.fire()
        XCTAssertEqual(fixture.coordinator.audioNotice, .likelyDenied)

        fixture.audio.emit([0.5, -0.5], channels: 2, rate: 48_000)
        fixture.clock.advance(1)
        fixture.scheduler.fire()

        XCTAssertNil(fixture.coordinator.audioNotice)
        XCTAssertEqual(fixture.bridge.audioSink.events.count, 1)
        XCTAssertEqual(fixture.bridge.audioSink.events.first?.frames, 1)
    }

    // MARK: - Fixture

    private struct Fixture {
        let coordinator: InputCoordinator
        let bridge: FakeInputBridge
        let keys: FakeKeyCapture
        let audio: FakeAudioCapture
        let clock: FakeClock
        let scheduler: FakeScheduler
        let defaults: UserDefaults
    }

    private func make(
        auth: KeyAuth = .granted,
        keyStartResult: Bool = true,
        environment: [String: String] = [:]
    ) -> Fixture {
        let suite = "InputCoordinatorTests.\(UUID().uuidString)"
        suites.append(suite)
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)

        let bridge = FakeInputBridge()
        let keys = FakeKeyCapture()
        keys.auth = auth
        keys.startResult = keyStartResult
        let audio = FakeAudioCapture()
        let clock = FakeClock()
        let scheduler = FakeScheduler()
        let coordinator = InputCoordinator(
            bridge: bridge,
            keyCapture: keys,
            audioCapture: audio,
            defaults: defaults,
            environment: environment,
            clock: clock,
            scheduler: scheduler
        )
        return Fixture(
            coordinator: coordinator,
            bridge: bridge,
            keys: keys,
            audio: audio,
            clock: clock,
            scheduler: scheduler,
            defaults: defaults
        )
    }
}

private final class KeySink: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [(name: String, down: Bool)] = []

    var events: [(name: String, down: Bool)] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func append(name: String, down: Bool) {
        lock.lock()
        defer { lock.unlock() }
        stored.append((name, down))
    }
}

private final class AudioSink: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [(frames: Int, channels: UInt16, sampleRate: Double)] = []

    var events: [(frames: Int, channels: UInt16, sampleRate: Double)] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func append(frames: Int, channels: UInt16, sampleRate: Double) {
        lock.lock()
        defer { lock.unlock() }
        stored.append((frames, channels, sampleRate))
    }
}

private final class FakeInputBridge: InputBridge {
    var wanted: InputWants = []
    let keySink = KeySink()
    let audioSink = AudioSink()

    @MainActor
    func inputWanted() -> InputWants {
        wanted
    }

    func pushKey(_ name: String, down: Bool) -> Int32 {
        keySink.append(name: name, down: down)
        return 0
    }

    func pushAudio(
        _ samples: UnsafeBufferPointer<Float>,
        frames: Int,
        channels: UInt16,
        sampleRate: Double
    ) -> Int32 {
        audioSink.append(frames: frames, channels: channels, sampleRate: sampleRate)
        return 0
    }
}

private final class FakeKeyCapture: KeyCapturing {
    var auth: KeyAuth = .granted
    var grantOnRequest = false
    var startResult = true
    private(set) var authorizationRequests = 0
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var onKey: ((String, Bool) -> Void)?

    func authorization() -> KeyAuth {
        auth
    }

    func requestAuthorization() {
        authorizationRequests += 1
        if grantOnRequest {
            auth = .granted
        }
    }

    func start(onKey: @escaping (String, Bool) -> Void) -> Bool {
        startCount += 1
        guard startResult else { return false }
        self.onKey = onKey
        return true
    }

    func stop() {
        stopCount += 1
        onKey = nil
    }
}

private final class FakeAudioCapture: AudioCapturing {
    var startResult: AudioStartResult = .started
    var othersPlaying = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    var onPCM: AudioPCMHandler?

    func start(onPCM: @escaping AudioPCMHandler) -> AudioStartResult {
        startCount += 1
        guard case .started = startResult else { return startResult }
        self.onPCM = onPCM
        return .started
    }

    func stop() {
        stopCount += 1
        onPCM = nil
    }

    func isAnyOtherProcessPlayingAudio() -> Bool {
        othersPlaying
    }

    func emit(_ samples: [Float], channels: UInt16, rate: Double) {
        guard let onPCM else { return }
        let frames = samples.count / Int(channels)
        samples.withUnsafeBufferPointer { pointer in
            onPCM(pointer, frames, channels, rate)
        }
    }
}

private final class FakeClock: InputClock {
    private(set) var current = Date(timeIntervalSince1970: 1_000)

    var now: Date { current }

    func advance(_ seconds: TimeInterval) {
        current = current.addingTimeInterval(seconds)
    }
}

private final class FakeScheduler: InputScheduler {
    private var action: (@Sendable @MainActor () -> Void)?
    private(set) var startCount = 0
    private(set) var stopCount = 0

    func start(_ action: @escaping @Sendable @MainActor () -> Void) {
        self.action = action
        startCount += 1
    }

    func stop() {
        action = nil
        stopCount += 1
    }

    @MainActor
    func fire() {
        action?()
    }
}
