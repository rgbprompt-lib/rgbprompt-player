import AppKit
import Combine
import IOKit.hid
import os
import PlayerKit
import UniformTypeIdentifiers

/// Small composition root: owns the core bridge, the panel, the setup and
/// settings windows, the HID watcher and the default-handler check. Every UI
/// mutation happens on the main actor.
@MainActor
final class AppController {
    let bridge: PlayerCoreBridge
    let previewPoller: PreviewPoller
    let handlerCoordinator: DefaultHandlerCoordinator
    let input: InputCoordinator
    let setupModel: SetupWindowModel
    let panelModel: PanelModel
    let settingsModel: SettingsModel
    let loginModel: LoginItemModel
    let language: LanguageStore

    private let panelController: PanelController
    private let setupController: SetupWindowController
    private let settingsController: SettingsWindowController
    private let statusItemController: StatusItemController
    private let loginItem: SMAppServiceLoginItem
    private let activation: ActivationPolicyCoordinator
    private let deviceWatcher: any DeviceChangeWatching
    private let logger = Logger(subsystem: "com.rgbprompt.player", category: "app")
    private var cancellables = Set<AnyCancellable>()
    private var panelVisible = false
    /// After 「稍后」, ignore NeedsDriver until the user explicitly plays/retries.
    private var driverInstallDeferred = false

    init() {
        let config = BridgeConfigBuilder.current()
        language = LanguageStore()
        bridge = PlayerCoreBridge(config: config)
        previewPoller = PreviewPoller(bridge: bridge)
        handlerCoordinator = DefaultHandlerCoordinator(bridge: bridge)
        settingsModel = SettingsModel()
        input = InputCoordinator(
            bridge: bridge,
            keyCapture: EventTapKeyCapture(),
            audioCapture: ProcessTapAudioCapture(),
            audioEnabled: settingsModel.audioEnabled
        )
        setupModel = SetupWindowModel()
        panelModel = PanelModel()
        loginItem = SMAppServiceLoginItem()
        loginModel = LoginItemModel(
            controller: loginItem,
            isInApplications: LoginItemModel.isInApplicationsFolder(Bundle.main.bundleURL)
        )
        activation = ActivationPolicyCoordinator { policy in
            NSApp.setActivationPolicy(policy == .regular ? .regular : .accessory)
        }

        let actions = PanelActions()
        let setupActions = SetupViewActions()
        let settingsActions = SettingsViewActions()
        panelController = PanelController(
            bridge: bridge,
            poller: previewPoller,
            handler: handlerCoordinator,
            input: input,
            setup: setupModel,
            panelModel: panelModel,
            language: language,
            actions: actions
        )
        statusItemController = StatusItemController(bridge: bridge, language: language)
        setupController = SetupWindowController(
            bridge: bridge,
            model: setupModel,
            language: language,
            activation: activation,
            actions: setupActions
        )
        settingsController = SettingsWindowController(
            bridge: bridge,
            model: settingsModel,
            language: language,
            login: loginModel,
            activation: activation,
            actions: settingsActions
        )
        deviceWatcher = IOKitDeviceChangeWatcher()

        #if DEBUG
        applyDevelopmentManifest()
        #endif

        if let preferred = KeyboardPreference.load() {
            _ = bridge.setPreferredKeyboard(preferred)
        }
        _ = bridge.refreshKeyboards()

        actions.openStudio = { [weak self] in self?.openStudio() }
        actions.openLibrary = { [weak self] in self?.openLibrary() }
        actions.playPreset = { [weak self] url, id in self?.playPreset(url, id: id) }
        actions.playLep = { [weak self] in self?.chooseLepFile() }
        actions.makeDefault = { [weak self] in self?.handlerCoordinator.makeDefault() }
        actions.quit = { [weak self] in self?.quit() }
        actions.dropLep = { [weak self] url in self?.open(.lepFile(url)) }
        actions.openKeySettings = { [weak self] in
            // Re-register the app with TCC first: if the user removed the stale
            // entry (e.g. after a re-sign), macOS only lists the app again once
            // it asks for access.
            _ = CGRequestListenEventAccess()
            _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent)
            self?.openPrivacySettings(anchor: Self.inputMonitoringAnchor)
        }
        actions.openAudioSettings = { [weak self] in
            self?.openPrivacySettings(anchor: Self.audioCaptureAnchor)
        }
        actions.openSetup = { [weak self] in self?.setupController.show() }
        actions.installDriver = { [weak self] in
            guard let self else { return }
            self.driverInstallDeferred = false
            _ = self.bridge.installDriver()
            self.setupController.show()
        }
        actions.declineDriver = { [weak self] in self?.declineDriver() }
        actions.retryDriver = { [weak self] in
            self?.driverInstallDeferred = false
            _ = self?.bridge.retry()
        }
        actions.selectKeyboard = { [weak self] name in self?.selectKeyboard(name) }
        actions.openSupportedKeyboards = { [weak self] in self?.openSupportedKeyboards() }
        actions.openSettings = { [weak self] in self?.openSettings() }
        actions.activityMonitorAvailable =
            NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.activityMonitorBundleID) != nil
        actions.openActivityMonitor = { [weak self] in self?.openActivityMonitor() }
        actions.hidePanel = { [weak self] in self?.panelController.hide() }

        setupActions.install = { [weak self] in
            self?.driverInstallDeferred = false
            _ = self?.bridge.installDriver()
        }
        setupActions.later = { [weak self] in self?.declineDriver() }
        setupActions.cancel = { [weak self] in self?.declineDriver() }
        setupActions.retry = { [weak self] in
            self?.driverInstallDeferred = false
            _ = self?.bridge.retry()
        }
        setupActions.openPrivacySettings = { [weak self] in
            self?.openPrivacySettings(anchor: Self.privacySecurityAnchor)
        }

        settingsActions.makeDefault = { [weak self] in self?.handlerCoordinator.makeDefault() }
        settingsActions.checkForUpdates = { [weak self] in self?.openDownloadPage() }
        settingsActions.copyDiagnostics = { [weak self] in self?.copyDiagnostics() ?? false }
        settingsActions.openLicenses = { [weak self] in self?.openLicenses() }

        input.onShowPanel = { [weak self] in self?.showPanel() }

        statusItemController.onToggle = { [weak self] in self?.togglePanel() }
        statusItemController.onDropLep = { [weak self] url in self?.open(.lepFile(url)) }

        let statusItemController = statusItemController
        panelController.statusButtonProvider = { [weak statusItemController] in
            statusItemController?.button
        }
        panelController.onVisibilityChange = { [weak self] visible in
            self?.panelVisibilityChanged(visible)
        }

        deviceWatcher.onDevicesChanged = { [weak self] in
            MainActor.assumeIsolated {
                _ = self?.bridge.notifyDevicesChanged()
            }
        }
        deviceWatcher.start()

        bridge.$state
            .sink { [weak self] state in
                // The bridge publishes on the main thread. Handle each state in
                // order: an unstructured Task could run Preparing after Playing
                // and tear the captures down while the effect plays.
                MainActor.assumeIsolated {
                    self?.input.update(state: state)
                }
                // `$state` fires before the property changes; read the rest
                // next turn.
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        if case .needsDriver = state, self.driverInstallDeferred {
                            _ = self.bridge.stop()
                            return
                        }
                        if case .idle = state {
                            // Keep deferred across Studio retries; clear only on explicit play.
                        } else if case .playing = state {
                            self.driverInstallDeferred = false
                        }
                        self.setupModel.apply(state: state, driverInfo: self.bridge.driverInfo)
                        self.panelModel.apply(state: state, keyboardName: self.bridge.keyboardName)
                        self.refreshSettings()
                        self.updatePolling()
                    }
                }
            }
            .store(in: &cancellables)

        handlerCoordinator.$isDefaultForScheme
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.refreshSettings()
                }
            }
            .store(in: &cancellables)

        settingsModel.$audioEnabled
            .sink { [weak self] enabled in
                MainActor.assumeIsolated {
                    self?.input.setAudioEnabled(enabled)
                    _ = self?.bridge.setAudioEnabled(enabled)
                }
            }
            .store(in: &cancellables)

        settingsModel.$brightness
            .sink { [weak self] brightness in
                MainActor.assumeIsolated {
                    _ = self?.bridge.setBrightness(brightness)
                }
            }
            .store(in: &cancellables)

        language.$effective
            .removeDuplicates()
            .sink { [weak self] effective in
                MainActor.assumeIsolated {
                    _ = self?.bridge.setLanguage(effective.rawValue)
                }
            }
            .store(in: &cancellables)
    }

    func didLaunch() {
        handlerCoordinator.refresh()
        panelModel.apply(state: bridge.state, keyboardName: bridge.keyboardName)
        refreshSettings()
        #if DEBUG
        applyDebugPanelScene()
        #endif
    }

    #if DEBUG
    /// Debug builds only: `RGBP_DEBUG_PANEL=preset:<id>[,picker][,settings]` plays a bundled
    /// preset and/or opens the picker, so the panel states can be reviewed
    /// without clicking.
    private func applyDebugPanelScene() {
        guard let scene = ProcessInfo.processInfo.environment["RGBP_DEBUG_PANEL"] else { return }
        let parts = scene.split(separator: ",").map(String.init)
        for part in parts where part.hasPrefix("preset:") {
            let id = String(part.dropFirst("preset:".count))
            if let preset = PresetCatalog.load().first(where: { $0.id == id }), let url = preset.fileURL {
                playPreset(url, id: id)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.panelController.show()
            if parts.contains("picker") {
                self?.panelController.debugOpenPicker()
            }
            if parts.contains("settings") {
                self?.openSettings()
            }
        }
    }
    #endif

    func open(_ entry: EntryPoint) {
        // Play/push must not change panel visibility. Only rgbprompt://open
        // (EntryPoint.revealsPanel) may show the panel; otherwise a hidden
        // panel stays hidden while the effect still starts.
        if entry.revealsPanel {
            showPanel()
            return
        }
        switch entry {
        case .playerURL(let url):
            setupModel.notePlayRequest()
            if let error = bridge.openURL(url.absoluteString) {
                logger.error("openURL failed: \(String(describing: error), privacy: .public)")
            }
        case .lepFile(let url):
            setupModel.notePlayRequest()
            // A copy of a bundled preset opened from Finder plays as that preset
            // (clean name, source "built-in").
            let presetId = Self.bundledPresetId(matching: url)
            if let error = bridge.openLepFile(url.path, presetId: presetId) {
                logger.error("openLepFile failed: \(String(describing: error), privacy: .public)")
            }
        case .ignored:
            break
        }
    }

    static func bundledPresetId(matching url: URL) -> String? {
        guard let data = try? Data(contentsOf: url), data.count <= 64 * 1024 else { return nil }
        return PresetCatalog.load().first { preset in
            guard let file = preset.fileURL else { return false }
            return (try? Data(contentsOf: file)) == data
        }?.id
    }

    func shutdown() {
        deviceWatcher.stop()
        previewPoller.setActive(false)
        input.shutdown()
        bridge.shutdown()
    }

    private func applyDevelopmentManifest() {
        #if DEBUG
        guard
            let path = ProcessInfo.processInfo.environment["RGBP_DEV_DRIVER_MANIFEST"],
            let json = try? String(contentsOfFile: path, encoding: .utf8)
        else { return }
        if let error = bridge.setDriverManifest(json: json) {
            logger.error("driver_manifest_override failed: \(String(describing: error), privacy: .public)")
        } else {
            logger.info("driver_manifest_override")
        }
        #endif
    }

    private func declineDriver() {
        driverInstallDeferred = true
        _ = bridge.stop()
        setupController.close()
    }

    private func selectKeyboard(_ name: String) {
        KeyboardPreference.save(name)
        _ = bridge.setPreferredKeyboard(name)
    }

    private func showPanel() {
        panelController.show()
    }

    private func togglePanel() {
        panelController.toggle()
    }

    private func openSettings() {
        panelController.hide()
        handlerCoordinator.refresh()
        loginModel.refresh()
        // Soft-probe via rgbp_driver_info_json so Settings sees an external
        // OpenRGB already listening on 6742 even before the first play.
        _ = bridge.loadDriverInfo()
        refreshSettings()
        settingsController.show()
    }

    private func refreshSettings() {
        settingsModel.apply(
            state: bridge.state,
            driverInfo: bridge.driverInfo,
            lastKeyboardName: panelModel.lastKeyboardName,
            schemeRegistered: handlerCoordinator.isDefaultForScheme
        )
    }

    private func panelVisibilityChanged(_ visible: Bool) {
        panelVisible = visible
        if visible {
            handlerCoordinator.refresh()
        }
        input.setPanelVisible(visible)
        updatePolling()
    }

    private func updatePolling() {
        previewPoller.setActive(panelVisible && bridge.state.isPlaying)
    }

    private func copyDiagnostics() -> Bool {
        DiagnosticsCopier(
            source: bridge,
            config: bridge.config,
            protocolRegistered: handlerCoordinator.isDefaultForScheme
        ).copy()
    }

    private static let inputMonitoringAnchor =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
    private static let audioCaptureAnchor =
        "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture"
    private static let privacySecurityAnchor =
        "x-apple.systempreferences:com.apple.preference.security"
    private static let activityMonitorBundleID = "com.apple.ActivityMonitor"

    private func openPrivacySettings(anchor: String) {
        if let url = URL(string: anchor), NSWorkspace.shared.open(url) {
            return
        }
        if let fallback = URL(string: Self.privacySecurityAnchor) {
            NSWorkspace.shared.open(fallback)
        }
    }

    private func openStudio() {
        guard let studio = BridgeConfigBuilder.studioURL(apiBase: bridge.config.apiBase) else {
            return
        }
        panelController.hide()
        NSWorkspace.shared.open(studio)
    }

    private func openLibrary() {
        guard let library = BridgeConfigBuilder.libraryURL(apiBase: bridge.config.apiBase) else {
            return
        }
        panelController.hide()
        NSWorkspace.shared.open(library)
    }

    private func playPreset(_ url: URL, id: String) {
        driverInstallDeferred = false
        _ = bridge.openLepFile(url.path, presetId: id)
    }

    private func openDownloadPage() {
        guard let page = BridgeConfigBuilder.downloadPageURL(apiBase: bridge.config.apiBase) else {
            return
        }
        panelController.hide()
        NSWorkspace.shared.open(page)
    }

    private func openLicenses() {
        // XcodeGen copies Resources/Licenses/OpenRGB.txt to the bundle
        // resource root (same as OFL.txt). Keep the subdirectory lookup
        // in case a future folder-reference build preserves the folder.
        let url = Bundle.main.url(forResource: "OpenRGB", withExtension: "txt", subdirectory: "Licenses")
            ?? Bundle.main.url(forResource: "OpenRGB", withExtension: "txt")
        guard let url else { return }
        panelController.hide()
        NSWorkspace.shared.open(url)
    }

    private func openSupportedKeyboards() {
        guard let site = BridgeConfigBuilder.siteOrigin(apiBase: bridge.config.apiBase) else {
            return
        }
        panelController.hide()
        NSWorkspace.shared.open(site.appendingPathComponent("player"))
    }

    private func openActivityMonitor() {
        guard
            let url = NSWorkspace.shared.urlForApplication(
                withBundleIdentifier: Self.activityMonitorBundleID
            )
        else {
            return
        }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    private func chooseLepFile() {
        driverInstallDeferred = false
        panelController.hide()
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let type = UTType("com.rgbprompt.lep") ?? UTType(filenameExtension: "lep", conformingTo: .data) {
            panel.allowedContentTypes = [type]
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        open(.lepFile(url))
    }

    private func quit() {
        deviceWatcher.stop()
        input.shutdown()
        _ = bridge.stop()
        Task { @MainActor [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(1)
            while Date() < deadline {
                if case .idle = self.bridge.state { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            self.bridge.shutdown()
            NSApp.terminate(nil)
        }
    }
}
