import Combine
import Foundation
import os
import RGBPromptPlayerCore

/// Input bits reported by `rgbp_input_wanted` (PLAYER §9.0.2): bit 0 audio,
/// bit 1 keys.
public struct InputWants: OptionSet, Hashable, Sendable {
    public let rawValue: UInt32

    public init(rawValue: UInt32) {
        self.rawValue = rawValue
    }

    public static let audio = InputWants(rawValue: 1 << 0)
    public static let keys = InputWants(rawValue: 1 << 1)
}

public struct PreviewFrame: Equatable, Sendable {
    public let seq: Int64
    public let rgb: [UInt8]

    public init(seq: Int64, rgb: [UInt8]) {
        self.seq = seq
        self.rgb = rgb
    }
}

private final class CoreCallbackBox: @unchecked Sendable {
    weak var bridge: PlayerCoreBridge?

    func deliver(_ event: CoreStateEvent) {
        bridge?.enqueue(event)
    }
}

/// Where the playing effect came from; the panel shows it under the name.
public enum PlaySource: Equatable, Sendable {
    case none
    case preset(id: String)
    case web
    case file
}

/// Owns the C core handle and republishes its state on the main actor. All C
/// commands return immediately per the ABI; the callback runs on the core's
/// control thread and is copied into a `CoreStateEvent` before hopping to main.
/// A keyboard OpenRGB reported, filtered by the shell to per-key support for the picker.
public struct PlayerKeyboard: Equatable, Sendable {
    public let name: String
    public let support: String

    public init(name: String, support: String) {
        self.name = name
        self.support = support
    }

    public var isPerKey: Bool { support == "per_key" }
}

/// Owns the C core handle and republishes its state on the main actor. All C
/// commands return immediately per the ABI; the callback runs on the core's
/// control thread and is copied into a `CoreStateEvent` before hopping to main.
@MainActor
public final class PlayerCoreBridge: ObservableObject {
    @Published public private(set) var state: PanelState = .idle(failure: nil)
    @Published public private(set) var effectName: String = ""
    @Published public private(set) var keyboardName: String = ""
    @Published public private(set) var keyboardSupport: KeyboardSupport = .unknown
    @Published public private(set) var fps: UInt32 = 0
    @Published public private(set) var driverProgress: Int?
    @Published public private(set) var driverInfo: DriverInfo?
    @Published public private(set) var keyboards: [PlayerKeyboard] = []
    @Published public private(set) var lastFailure: FailureCode?
    @Published public private(set) var conflictName: String?
    /// True after the user stopped a playing effect. Stop turns the keys off
    /// (the core cannot restore the keyboard's own lighting, PLY-20), so the
    /// Idle card tells the user to replug the keyboard. Cleared by the next play.
    @Published public private(set) var stoppedByUser = false
    /// Where the current (or last) effect came from. Set by the open commands.
    @Published public private(set) var playSource: PlaySource = .none

    public let config: BridgeConfig

    private let logger = Logger(subsystem: "com.rgbprompt.player", category: "core")
    private let callbackBox = CoreCallbackBox()
    private var localFileName: String?
    nonisolated(unsafe) private var handle: UnsafeMutablePointer<RgbpHandle>?
    private static let stateCallback: RgbpStateCallback = { event, user in
        guard let event, let user else { return }
        let box = Unmanaged<CoreCallbackBox>.fromOpaque(user).takeUnretainedValue()
        box.deliver(CoreStateEvent(copying: event))
    }

    public init(config: BridgeConfig) {
        self.config = config
        try? FileManager.default.createDirectory(
            atPath: config.dataDir,
            withIntermediateDirectories: true
        )

        guard rgbp_abi_version() == UInt32(RGBP_ABI_VERSION) else {
            logger.error(
                "ABI mismatch: core \(rgbp_abi_version()) expected \(RGBP_ABI_VERSION)"
            )
            state = .coreUnavailable
            return
        }

        let created = Self.createCore(with: config)
        guard let created else {
            logger.error("rgbp_create returned null")
            state = .coreUnavailable
            return
        }
        handle = created
        callbackBox.bridge = self

        let callbackResult = rgbp_set_state_callback(
            created,
            Self.stateCallback,
            Unmanaged.passUnretained(callbackBox).toOpaque()
        )
        if callbackResult != 0 {
            logger.error("rgbp_set_state_callback failed: \(callbackResult)")
            rgbp_destroy(created)
            handle = nil
            callbackBox.bridge = nil
            state = .coreUnavailable
            return
        }

        loadDriverInfo()
        let host = URL(string: config.apiBase)?.host ?? "?"
        logger.info("core ready; api host=\(host, privacy: .public)")
    }

    #if DEBUG
    /// Offscreen previews and tests render real views without a C handle.
    public init(previewState: PanelState, driverInfo: DriverInfo? = nil) {
        self.config = BridgeConfig(
            dataDir: NSTemporaryDirectory(),
            apiBase: "https://rgbprompt.com/api",
            language: "en",
            appVersion: "0.0.0",
            osVersion: "14.2.0",
            openrgbAddr: nil
        )
        self.state = previewState
        self.driverInfo = driverInfo
    }
    #endif

    deinit {
        if let handle {
            rgbp_destroy(handle)
        }
    }

    // MARK: - Commands

    @discardableResult
    public func openURL(_ url: String) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        lastFailure = nil
        localFileName = nil
        stoppedByUser = false
        playSource = .web
        logger.info("open url \(Redact.playerURL(url), privacy: .public)")
        return BridgeError.from(code: rgbp_open_url(handle, url))
    }

    @discardableResult
    public func openLepFile(_ path: String, presetId: String? = nil) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        lastFailure = nil
        stoppedByUser = false
        playSource = presetId.map { .preset(id: $0) } ?? .file
        // The core reports no effect name for local files; show the file name.
        localFileName = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        logger.info("open .lep file")
        return BridgeError.from(code: rgbp_open_lep_file(handle, path))
    }

    @discardableResult
    public func stop() -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        if state.isPlaying {
            stoppedByUser = true
        }
        return BridgeError.from(code: rgbp_stop(handle))
    }

    @discardableResult
    public func retry() -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        return BridgeError.from(code: rgbp_retry(handle))
    }

    @discardableResult
    public func installDriver() -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        return BridgeError.from(code: rgbp_install_driver(handle))
    }

    @discardableResult
    public func restartBackend() -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        return BridgeError.from(code: rgbp_restart_backend(handle))
    }

    /// Replaces the manifest used by the next install and launch (dev/test
    /// override, PLAYER §4). Release builds never call this.
    @discardableResult
    public func setDriverManifest(json: String) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        let result = json.withCString { rgbp_set_driver_manifest_json(handle, $0) }
        if result == 0 {
            loadDriverInfo()
        }
        return BridgeError.from(code: result)
    }

    /// The shell's HID hot-plug watcher tells the core to rescan devices.
    @discardableResult
    public func notifyDevicesChanged() -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        return BridgeError.from(code: rgbp_notify_devices_changed(handle))
    }

    @discardableResult
    public func setPreferredKeyboard(_ name: String?) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        let value = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let result = value.withCString { rgbp_set_preferred_keyboard(handle, $0) }
        return BridgeError.from(code: result)
    }

    /// Refresh the per-key keyboard list from diagnostics (PLAYER device picker).
    @discardableResult
    public func refreshKeyboards() -> [PlayerKeyboard] {
        guard let json = diagnosticsJSON(),
              let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let devices = object["devices"] as? [[String: Any]] else {
            keyboards = []
            return keyboards
        }
        keyboards = devices.compactMap { device in
            guard let name = device["name"] as? String,
                  let support = device["support"] as? String,
                  support == "per_key",
                  !name.isEmpty else { return nil }
            return PlayerKeyboard(name: name, support: support)
        }
        return keyboards
    }


    @discardableResult
    public func setProtocolRegistered(_ registered: Bool) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        return BridgeError.from(code: rgbp_set_protocol_registered(handle, registered))
    }

    /// The value is clamped by the caller (`BrightnessPreference`); the core
    /// rejects anything outside 10..100.
    @discardableResult
    public func setBrightness(_ brightness: Int) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        return BridgeError.from(
            code: rgbp_set_brightness(handle, UInt8(clamping: brightness))
        )
    }

    @discardableResult
    public func setLanguage(_ language: String) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        let result = language.withCString { rgbp_set_language(handle, $0) }
        return BridgeError.from(code: result)
    }

    @discardableResult
    public func setAudioEnabled(_ enabled: Bool) -> BridgeError? {
        guard let handle else { return .coreUnavailable }
        return BridgeError.from(code: rgbp_set_audio_enabled(handle, enabled))
    }

    /// Reads the input bits the current effect wants. Unknown or unavailable
    /// handles report no wants.
    public func inputWanted() -> InputWants {
        guard let handle else { return [] }
        return InputWants(rawValue: rgbp_input_wanted(handle))
    }

    /// Pushes one key event. Safe to call from the event-tap thread; the core
    /// never blocks or allocates on this path.
    public nonisolated func pushKey(_ name: String, down: Bool) -> Int32 {
        guard let handle else { return Int32(RGBP_ERR_INVALID_ARGUMENT) }
        return name.withCString { rgbp_push_key(handle, $0, down) }
    }

    /// Pushes interleaved `f32` PCM. Safe to call from the audio thread.
    public nonisolated func pushAudio(
        _ samples: UnsafeBufferPointer<Float>,
        frames: Int,
        channels: UInt16,
        sampleRate: Double
    ) -> Int32 {
        guard let handle, let base = samples.baseAddress else {
            return Int32(RGBP_ERR_INVALID_ARGUMENT)
        }
        return rgbp_push_audio_pcm(handle, base, UInt(frames), channels, sampleRate)
    }

    public func previewFrame() -> PreviewFrame? {
        guard let handle else { return nil }
        var bytes = [UInt8](repeating: 0, count: 104 * 3)
        let seq = bytes.withUnsafeMutableBufferPointer { buffer in
            rgbp_preview_frame(handle, buffer.baseAddress)
        }
        guard seq >= 0 else { return nil }
        return PreviewFrame(seq: seq, rgb: bytes)
    }

    public func diagnosticsJSON() -> String? {
        guard let handle else { return nil }
        var capacity = 16 * 1024
        let maximum = 16 * 1024 * 1024
        while capacity <= maximum {
            var buffer = [CChar](repeating: 0, count: capacity)
            let result = buffer.withUnsafeMutableBufferPointer { pointer in
                rgbp_diagnostics_json(handle, pointer.baseAddress, UInt(capacity))
            }
            if result >= 0 {
                let bytes = buffer.prefix(Int(result)).map { UInt8(bitPattern: $0) }
                return String(decoding: bytes, as: UTF8.self)
            }
            if result == FailureCode.bufferTooSmall.code {
                capacity *= 2
                continue
            }
            return nil
        }
        return nil
    }

    @discardableResult
    public func loadDriverInfo() -> DriverInfo? {
        guard let handle else { return nil }
        var capacity = 16 * 1024
        let maximum = 16 * 1024 * 1024
        while capacity <= maximum {
            var buffer = [CChar](repeating: 0, count: capacity)
            let result = buffer.withUnsafeMutableBufferPointer { pointer in
                rgbp_driver_info_json(handle, pointer.baseAddress, UInt(capacity))
            }
            if result >= 0 {
                let data = Data(buffer.map { UInt8(bitPattern: $0) }.prefix(Int(result)))
                let decoded = try? JSONDecoder().decode(DriverInfo.self, from: data)
                driverInfo = decoded
                return decoded
            }
            if result == FailureCode.bufferTooSmall.code {
                capacity *= 2
                continue
            }
            return nil
        }
        return nil
    }

    /// Called on quit after `stop()`. `rgbp_destroy` blocks until the control
    /// thread has stopped; the callback box outlives the handle.
    public func shutdown() {
        guard let handle else { return }
        _ = rgbp_stop(handle)
        rgbp_destroy(handle)
        self.handle = nil
        callbackBox.bridge = nil
    }

    // MARK: - State callback

    /// `DispatchQueue.main` is FIFO, so state events keep the order the core
    /// emitted them in (unstructured `Task`s on the main actor do not promise that).
    nonisolated func enqueue(_ event: CoreStateEvent) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.apply(event)
            }
        }
    }

    private func apply(_ event: CoreStateEvent) {
        loadDriverInfo()
        effectName = event.effectName.isEmpty ? (localFileName ?? "") : event.effectName
        keyboardName = event.keyboardName
        keyboardSupport = KeyboardSupport(rawValue: event.keyboardSupport) ?? .unknown
        _ = refreshKeyboards()
        fps = event.fps
        driverProgress = event.driverProgress >= 0 ? Int(event.driverProgress) : nil
        conflictName = event.conflictName

        let mapped = PanelState.from(event)
        state = mapped
        switch mapped {
        case .idle(let failure):
            lastFailure = failure
        case .playing:
            lastFailure = nil
            stoppedByUser = false
        default:
            break
        }
    }

    private static func createCore(with config: BridgeConfig) -> UnsafeMutablePointer<RgbpHandle>? {
        config.dataDir.withCString { dataDir in
            config.apiBase.withCString { apiBase in
                "mac".withCString { platform in
                    config.language.withCString { language in
                        config.appVersion.withCString { appVersion in
                            config.osVersion.withCString { osVersion in
                                if let address = config.openrgbAddr {
                                    return address.withCString { openrgbAddr in
                                        var raw = RgbpConfig(
                                            data_dir: dataDir,
                                            api_base: apiBase,
                                            platform: platform,
                                            language: language,
                                            app_version: appVersion,
                                            os_version: osVersion,
                                            openrgb_addr: openrgbAddr
                                        )
                                        return rgbp_create(&raw)
                                    }
                                }
                                var raw = RgbpConfig(
                                    data_dir: dataDir,
                                    api_base: apiBase,
                                    platform: platform,
                                    language: language,
                                    app_version: appVersion,
                                    os_version: osVersion,
                                    openrgb_addr: nil
                                )
                                return rgbp_create(&raw)
                            }
                        }
                    }
                }
            }
        }
    }
}
