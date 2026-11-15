import PlayerKit
import SwiftUI

/// Side effects owned by `AppController`; the settings view only invokes them.
final class SettingsViewActions {
    var makeDefault: () -> Void = {}
    var checkForUpdates: () -> Void = {}
    var copyDiagnostics: () -> Bool = { false }
    var openLicenses: () -> Void = {}
}

struct SettingsRootView: View {
    @ObservedObject var bridge: PlayerCoreBridge
    @ObservedObject var model: SettingsModel
    @ObservedObject var language: LanguageStore
    @ObservedObject var login: LoginItemModel
    let actions: SettingsViewActions

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            statusSection
            preferencesSection
            Spacer(minLength: 0)
            footer
        }
        .padding(.top, 18)
        .padding(.horizontal, 22)
        .padding(.bottom, 22)
        .frame(width: 400, height: 560, alignment: .topLeading)
        .background(Theme.windowBackground)
    }

    // MARK: - Status

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("settings.section.status")
            VStack(spacing: 0) {
                statusRow(model.status.driver)
                rowDivider
                statusRow(model.status.keyboard)
                rowDivider
                statusRow(model.status.webLink)
            }
            .background(Theme.background, in: cardShape)
            .overlay(cardShape.stroke(Theme.border, lineWidth: 1))
        }
    }

    private func statusRow(_ row: SettingsStatusRow) -> some View {
        HStack(spacing: 10) {
            ZStack {
                Circle()
                    .fill(row.ok ? Theme.primary : Theme.disabled)
                if row.ok {
                    Image(systemName: "checkmark")
                        .font(Typography.sans(9, .bold))
                        .foregroundStyle(Theme.onPrimary)
                }
            }
            .frame(width: 16, height: 16)

            Text(L10n.tr(row.titleKey))
                .font(Typography.sans(13))
                .foregroundStyle(Theme.text)

            Spacer(minLength: 8)

            Text(detailText(row.detail))
                .font(Typography.sans(12))
                .foregroundStyle(Theme.tertiary)
                .lineLimit(1)

            if row.showsMakeDefault {
                Button(action: actions.makeDefault) {
                    Text(L10n.tr("settings.webLink.makeDefault"))
                        .font(Typography.sans(12))
                        .foregroundStyle(Theme.accent)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func detailText(_ detail: SettingsDetail) -> String {
        switch detail {
        case .driverReady(let version):
            return L10n.format("settings.status.driverReady", version)
        case .driverExternal(let port):
            return L10n.format("settings.status.driverExternal", port)
        case .driverMissing:
            return L10n.tr("settings.status.driverMissing")
        case .keyboardName(let name):
            return name
        case .keyboardMissing:
            return L10n.tr("settings.status.keyboardMissing")
        case .webRegistered:
            return L10n.tr("settings.status.webRegistered")
        case .webMissing:
            return L10n.tr("settings.status.webMissing")
        }
    }

    // MARK: - Preferences

    private var preferencesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("settings.section.preferences")
            VStack(spacing: 0) {
                preferenceRow("settings.preference.language") {
                    languageSegment
                }
                rowDivider
                preferenceRow("settings.preference.sound") {
                    soundSegment
                }
                rowDivider
                brightnessRow
                rowDivider
                launchRow
                rowDivider
                stopRow
            }
            .background(Theme.background, in: cardShape)
            .overlay(cardShape.stroke(Theme.border, lineWidth: 1))
        }
    }

    private func preferenceRow<Content: View>(
        _ titleKey: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        HStack(spacing: 12) {
            Text(L10n.tr(titleKey))
                .font(Typography.sans(13))
                .foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            content()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var languageSegment: some View {
        Segmented(
            options: [
                .init(id: PlayerLanguage.chinese, title: L10n.tr("settings.language.chinese")),
                .init(id: PlayerLanguage.english, title: L10n.tr("settings.language.english")),
            ],
            selection: language.effective
        ) { value in
            language.set(value)
        }
    }

    private var soundSegment: some View {
        Segmented(
            options: [
                .init(id: true, title: L10n.tr("settings.sound.system")),
                .init(id: false, title: L10n.tr("settings.sound.off")),
            ],
            selection: model.audioEnabled
        ) { enabled in
            model.setAudioEnabled(enabled)
        }
    }

    private var brightnessRow: some View {
        HStack(spacing: 12) {
            Text(L10n.tr("settings.preference.brightness"))
                .font(Typography.sans(13))
                .foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            Slider(
                value: Binding(
                    get: { Double(model.brightness) },
                    // Snap in the binding instead of `step:`, which draws tick dots.
                    set: { model.setBrightness(BrightnessPreference.snap(Int($0.rounded()))) }
                ),
                in: Double(BrightnessPreference.minimum)...Double(BrightnessPreference.maximum)
            )
            .tint(Theme.primary)
            .frame(width: 140)
            Text(L10n.format("settings.brightness.value", model.brightness))
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Theme.tertiary)
                .frame(width: 38, alignment: .trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var launchRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n.tr("settings.preference.launchAtLogin"))
                        .font(Typography.sans(13))
                        .foregroundStyle(Theme.text)
                    Text(L10n.tr("settings.launch.hint"))
                        .font(Typography.sans(11))
                        .foregroundStyle(Theme.tertiary)
                }
                Spacer(minLength: 8)
                ToggleSwitch(
                    isOn: login.isOn,
                    isEnabled: login.isToggleEnabled
                ) {
                    login.toggle(on: !login.isOn)
                }
            }

            if login.needsApproval {
                HStack(spacing: 6) {
                    Text(L10n.tr("settings.launch.requiresApproval"))
                        .font(Typography.sans(11))
                        .foregroundStyle(Theme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(action: login.openSystemSettings) {
                        Text(L10n.tr("settings.launch.openLoginItems"))
                            .font(Typography.sans(11))
                            .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                }
            }

            if login.isNotFound {
                Text(L10n.tr("settings.launch.notFound"))
                    .font(Typography.sans(11))
                    .foregroundStyle(Theme.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if login.errorKey != nil {
                Text(L10n.tr(LoginItemModel.errorKey))
                    .font(Typography.sans(11))
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private var stopRow: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(L10n.tr("settings.stop.title"))
                .font(Typography.sans(13))
                .foregroundStyle(Theme.text)
            Text(L10n.tr("settings.stop.body"))
                .font(Typography.sans(11))
                .foregroundStyle(Theme.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    // MARK: - Footer

    private var footer: some View {
        // One row when it fits; otherwise the version line sits above the links
        // (the English copy is too long for a single 356 pt row).
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) {
                versionText.fixedSize()
                Spacer(minLength: 0)
                footerLinks
            }
            VStack(alignment: .leading, spacing: 6) {
                versionText
                footerLinks
            }
        }
    }

    private var versionText: some View {
        Text(L10n.format("settings.footer.version", bridge.config.appVersion))
            .font(Typography.sans(12))
            .foregroundStyle(Theme.tertiary)
            .lineLimit(1)
    }

    private var footerLinks: some View {
        HStack(spacing: 12) {
            Button(action: actions.checkForUpdates) {
                Text(L10n.tr("settings.footer.checkUpdates"))
                    .font(Typography.sans(12))
                    .foregroundStyle(Theme.accent)
            }
            .buttonStyle(.plain)
            Button(action: copyDiagnostics) {
                Text(L10n.tr(copied ? "settings.footer.copied" : "settings.footer.copyDiagnostics"))
                    .font(Typography.sans(12))
                    .foregroundStyle(Theme.accent)
            }
            .buttonStyle(.plain)
            Button(action: actions.openLicenses) {
                Text(L10n.tr("settings.footer.licenses"))
                    .font(Typography.sans(12))
                    .foregroundStyle(Theme.accent)
            }
            .buttonStyle(.plain)
        }
        .fixedSize()
    }

    private func copyDiagnostics() {
        guard actions.copyDiagnostics() else { return }
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    // MARK: - Pieces

    private var cardShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
    }

    private var rowDivider: some View {
        Rectangle()
            .fill(Theme.border)
            .frame(height: 1)
    }

    private func sectionLabel(_ key: String) -> some View {
        Text(L10n.tr(key))
            .font(Typography.sans(12))
            .foregroundStyle(Theme.secondary)
    }
}

private struct Segmented<Value: Hashable>: View {
    struct Option: Identifiable {
        let id: Value
        let title: String
    }

    let options: [Option]
    let selection: Value
    let onSelect: (Value) -> Void

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options) { option in
                let selected = option.id == selection
                Button {
                    onSelect(option.id)
                } label: {
                    Text(option.title)
                        .font(Typography.sans(12))
                        .foregroundStyle(selected ? Theme.text : Theme.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                        .background(
                            selected ? Theme.stepIndex : Color.clear,
                            in: RoundedRectangle(cornerRadius: 5, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Theme.inset, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
    }
}

private struct ToggleSwitch: View {
    let isOn: Bool
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? Theme.primary : Theme.control)
                Circle()
                    .fill(Theme.text)
                    .frame(width: 16, height: 16)
                    .padding(2)
            }
            .frame(width: 34, height: 20)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.45)
    }
}

#if DEBUG
private final class PreviewLoginItemController: LoginItemControlling {
    var status: LoginItemStatus

    init(status: LoginItemStatus) {
        self.status = status
    }

    func register() throws {
        status = .enabled
    }

    func unregister() throws {
        status = .notRegistered
    }

    func openSystemSettings() {}
}

extension SettingsRootView {
    /// Offscreen preview with fixed data, mirroring `PlayerCoreBridge`'s Debug
    /// preview initializer.
    init(
        previewState: PanelState,
        driverInfo: DriverInfo? = nil,
        keyboardName: String = "Redragon K580",
        schemeRegistered: Bool = true,
        languageValue: PlayerLanguage = .english,
        audioEnabled: Bool = true,
        brightness: Int = 80,
        loginStatus: LoginItemStatus = .notRegistered
    ) {
        let suite = "SettingsPreview.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let model = SettingsModel(defaults: defaults)
        model.apply(
            state: previewState,
            driverInfo: driverInfo,
            lastKeyboardName: keyboardName,
            schemeRegistered: schemeRegistered
        )
        model.setAudioEnabled(audioEnabled)
        model.setBrightness(brightness)
        let store = LanguageStore(defaults: defaults, preferredLanguages: ["en"])
        store.set(languageValue)
        self.init(
            bridge: PlayerCoreBridge(previewState: previewState, driverInfo: driverInfo),
            model: model,
            language: store,
            login: LoginItemModel(controller: PreviewLoginItemController(status: loginStatus)),
            actions: SettingsViewActions()
        )
    }
}
#endif
