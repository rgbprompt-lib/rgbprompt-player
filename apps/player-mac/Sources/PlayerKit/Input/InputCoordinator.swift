import os
import Combine
import Darwin
import Foundation

public enum InputSettings {
    /// Set once the user has seen either the explanation or the denied banner.
    public static let keyInputExplained = "keyInputExplained"
    public static let disableCaptureEnvironment = "RGBP_DISABLE_INPUT_CAPTURE"
}

public protocol InputClock: AnyObject {
    var now: Date { get }
}

public final class SystemInputClock: InputClock {
    public init() {}
    public var now: Date { Date() }
}

public protocol InputScheduler: AnyObject {
    func start(_ action: @escaping @Sendable @MainActor () -> Void)
    func stop()
}

public final class TimerInputScheduler: InputScheduler {
    private var timer: Timer?

    public init() {}

    public func start(_ action: @escaping @Sendable @MainActor () -> Void) {
        stop()
        let timer = Timer(timeInterval: 0.2, repeats: true) { _ in
            Task { @MainActor in action() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
    }
}

/// The small surface the coordinator needs from the core bridge, so tests can
/// use a fake sink instead of a real `PlayerCoreBridge`.
public protocol InputBridge: AnyObject {
    @MainActor func inputWanted() -> InputWants
    func pushKey(_ name: String, down: Bool) -> Int32
    func pushAudio(
        _ samples: UnsafeBufferPointer<Float>,
        frames: Int,
        channels: UInt16,
        sampleRate: Double
    ) -> Int32
}

extension PlayerCoreBridge: InputBridge {}

/// Owns both input captures and the permission notices (PLAYER §5.1, §5.2, §6).
/// It installs a capture only while the effect is Playing and wants that input,
/// and tears it down on every other state change.
@MainActor
public final class InputCoordinator: ObservableObject {
    public enum KeyNotice: Equatable, Sendable {
        case explain
        case denied
        case needsRelaunch
    }

    public enum AudioNotice: Equatable, Sendable {
        case unavailable
        case likelyDenied
    }

    @Published public private(set) var keyNotice: KeyNotice?
    @Published public private(set) var audioNotice: AudioNotice?
    @Published public private(set) var audioWanted = false
    @Published public private(set) var level: Float = 0

    /// Shown programmatically when the key explanation first appears.
    public var onShowPanel: (() -> Void)?

    public var isCaptureDisabled: Bool { captureDisabled }

    private let bridge: any InputBridge
    private let keyCapture: any KeyCapturing
    private let audioCapture: any AudioCapturing
    private let clock: any InputClock
    private let scheduler: any InputScheduler
    private let defaults: UserDefaults
    private let meter = LevelMeter(decay: 0.85)
    private let activity = SampleActivity()
    private let captureDisabled: Bool

    private var audioEnabled: Bool
    private var lastState: PanelState = .idle(failure: nil)
    private var wantsKeys = false
    private var wantsAudio = false
    private var panelVisible = false
    private var keyTapInstalled = false
    private var audioRunning = false
    private var schedulerRunning = false
    private var lastKeyAuthCheck = Date.distantPast
    private var lastActivityCount: Int32 = 0
    private var lastActivityAt = Date.distantPast
    private var lastOutputCheck = Date.distantPast

    public init(
        bridge: any InputBridge,
        keyCapture: any KeyCapturing,
        audioCapture: any AudioCapturing,
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        clock: any InputClock = SystemInputClock(),
        scheduler: any InputScheduler = TimerInputScheduler(),
        audioEnabled: Bool = AudioPreference.defaultValue
    ) {
        self.bridge = bridge
        self.keyCapture = keyCapture
        self.audioCapture = audioCapture
        self.defaults = defaults
        self.clock = clock
        self.scheduler = scheduler
        self.audioEnabled = audioEnabled
        captureDisabled = environment[InputSettings.disableCaptureEnvironment] == "1"
    }

    /// Called for every bridge state change. Reads the wanted input bits and
    /// reconciles both captures.
    public func update(state: PanelState) {
        lastState = state
        let wanted = bridge.inputWanted()
        let playing = state.isPlaying

        wantsKeys = playing && wanted.contains(.keys) && !captureDisabled
        wantsAudio = playing && wanted.contains(.audio) && !captureDisabled && audioEnabled
        audioWanted = wantsAudio

        if wantsKeys {
            if !keyTapInstalled {
                reconcileKeyCapture()
            }
        } else {
            stopKeyCapture()
            keyNotice = nil
        }

        if wantsAudio {
            if !audioRunning {
                startAudioCapture()
            }
        } else {
            stopAudioCapture()
            audioNotice = nil
        }

        refreshScheduler()
    }

    /// Sound source "Off" (PLY-07): stop the process tap and hide the audio
    /// permission banner without disturbing key capture.
    public func setAudioEnabled(_ enabled: Bool) {
        guard audioEnabled != enabled else { return }
        audioEnabled = enabled
        update(state: lastState)
    }

    public func setPanelVisible(_ visible: Bool) {
        guard panelVisible != visible else { return }
        panelVisible = visible

        if visible {
            meter.reset()
            level = 0
            if wantsKeys && keyNotice != nil {
                lastKeyAuthCheck = clock.now
                if keyCapture.authorization() == .granted {
                    installKeyTap()
                }
            }
        } else {
            meter.reset()
            level = 0
        }
        refreshScheduler()
    }

    // MARK: - Key permission flow

    public func continueAfterKeyExplanation() {
        defaults.set(true, forKey: InputSettings.keyInputExplained)
        keyCapture.requestAuthorization()
        if keyCapture.authorization() == .granted {
            installKeyTap()
        } else {
            keyNotice = .denied
            lastKeyAuthCheck = clock.now
        }
        refreshScheduler()
    }

    public func notNowKeyExplanation() {
        defaults.set(true, forKey: InputSettings.keyInputExplained)
        keyNotice = .denied
        lastKeyAuthCheck = clock.now
        refreshScheduler()
    }

    public func shutdown() {
        wantsKeys = false
        wantsAudio = false
        audioWanted = false
        stopKeyCapture()
        stopAudioCapture()
        scheduler.stop()
        schedulerRunning = false
        keyNotice = nil
        audioNotice = nil
        level = 0
    }

    // MARK: - Reconciliation

    private func reconcileKeyCapture() {
        guard wantsKeys else { return }
        switch keyCapture.authorization() {
        case .granted:
            installKeyTap()
        case .denied, .notDetermined:
            if !defaults.bool(forKey: InputSettings.keyInputExplained) {
                if keyNotice != .explain {
                    keyNotice = .explain
                    lastKeyAuthCheck = clock.now
                    onShowPanel?()
                }
            } else if keyNotice != .denied && keyNotice != .needsRelaunch {
                keyNotice = .denied
                lastKeyAuthCheck = clock.now
            }
        }
    }

    private func installKeyTap() {
        guard !keyTapInstalled else {
            keyNotice = nil
            return
        }
        let bridge = bridge
        let started = keyCapture.start { name, down in
            let rc = bridge.pushKey(name, down: down)
            os_log("DBGKEY %{public}@ %{public}d rc=%{public}d", name, down ? 1 : 0, rc) // DEBUG-REMOVE
        }
        if started {
            keyTapInstalled = true
            keyNotice = nil
        } else {
            keyNotice = .needsRelaunch
            lastKeyAuthCheck = clock.now
        }
        refreshScheduler()
    }

    private func stopKeyCapture() {
        guard keyTapInstalled else { return }
        keyCapture.stop()
        keyTapInstalled = false
    }

    private func startAudioCapture() {
        let bridge = bridge
        let meter = meter
        let activity = activity
        let result = audioCapture.start { samples, frames, channels, sampleRate in
            _ = bridge.pushAudio(
                samples,
                frames: frames,
                channels: channels,
                sampleRate: sampleRate
            )
            meter.record(samples)
            activity.record(samples)
        }

        switch result {
        case .started:
            audioRunning = true
            audioNotice = nil
            lastActivityCount = activity.value()
            lastActivityAt = clock.now
        case .failed:
            audioRunning = false
            audioNotice = .unavailable
        }
        refreshScheduler()
    }

    private func stopAudioCapture() {
        guard audioRunning else { return }
        audioCapture.stop()
        audioRunning = false
        meter.reset()
        level = 0
    }

    // MARK: - Timer

    func tick() {
        let now = clock.now

        if wantsKeys, keyNotice != nil, keyNotice != .needsRelaunch,
           now.timeIntervalSince(lastKeyAuthCheck) >= 2 {
            lastKeyAuthCheck = now
            if keyCapture.authorization() == .granted {
                installKeyTap()
            }
        }

        if audioRunning {
            let count = activity.value()
            if count != lastActivityCount {
                lastActivityCount = count
                lastActivityAt = now
                if audioNotice == .likelyDenied {
                    audioNotice = nil
                }
            } else if now.timeIntervalSince(lastActivityAt) >= 3,
                      now.timeIntervalSince(lastOutputCheck) >= 1 {
                // The tick runs at 5 Hz for the level bars; query Core Audio
                // for other playing processes at most once a second.
                lastOutputCheck = now
                if audioCapture.isAnyOtherProcessPlayingAudio() {
                    audioNotice = .likelyDenied
                }
            }
        }

        if panelVisible && audioRunning {
            level = meter.snapshot()
        } else {
            level = 0
        }
    }

    private func refreshScheduler() {
        let needed = wantsKeys || wantsAudio || keyNotice != nil || audioNotice != nil
        if needed, !schedulerRunning {
            schedulerRunning = true
            scheduler.start { [weak self] in
                self?.tick()
            }
        } else if !needed, schedulerRunning {
            schedulerRunning = false
            scheduler.stop()
        }
    }
}

/// Lock-free "did any non-zero sample arrive" flag. The audio thread only
/// increments an atomic; the main actor reads it at 5 Hz.
final class SampleActivity: @unchecked Sendable {
    private let counter: UnsafeMutablePointer<Int32>

    init() {
        counter = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
        counter.initialize(to: 0)
    }

    deinit {
        counter.deallocate()
    }

    func record(_ samples: UnsafeBufferPointer<Float>) {
        for value in samples where value != 0 {
            OSAtomicIncrement32Barrier(counter)
            return
        }
    }

    func value() -> Int32 {
        OSAtomicAdd32Barrier(0, counter)
    }
}
