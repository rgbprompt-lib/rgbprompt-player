import AppKit
import PlayerKit
import SwiftUI

/// Side effects owned by `AppController`; the setup view only invokes them.
final class SetupViewActions {
    var install: () -> Void = {}
    var later: () -> Void = {}
    var cancel: () -> Void = {}
    var retry: () -> Void = {}
    var openPrivacySettings: () -> Void = {}
}

struct SetupRootView: View {
    @ObservedObject var bridge: PlayerCoreBridge
    @ObservedObject var model: SetupWindowModel
    @ObservedObject var language: LanguageStore
    let actions: SetupViewActions

    @State private var copied = false

    private let typeTitle = Typography.sans(22, .bold)
    private let typeBody = Typography.sans(14)
    private let typeSecondary = Typography.sans(13)
    private let typeLabel = Font.system(size: 11, design: .monospaced)
    private let typeTable = Typography.sans(13)
    private let typePath = Font.system(size: 12, design: .monospaced)

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            stepBar
            Text(L10n.tr(model.step == 1 ? "setup.step.driver" : "setup.step.gatekeeper"))
                .font(typeLabel)
                .foregroundStyle(Theme.accent)
            Text(titleText)
                .font(typeTitle)
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            Text(bodyText)
                .font(typeBody)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)

            content

            Spacer(minLength: 0)
            buttons
        }
        .padding(22)
        .frame(width: 400, height: 560, alignment: .topLeading)
        .background(Theme.windowBackground)
    }

    private var stepBar: some View {
        HStack(spacing: 6) {
            ForEach(1...2, id: \.self) { index in
                Capsule()
                    .fill(model.step >= index ? Theme.primary : Theme.inset)
                    .frame(height: 4)
                    .overlay(Capsule().stroke(Theme.border, lineWidth: model.step >= index ? 0 : 1))
            }
        }
    }

    private var titleText: String {
        switch model.content {
        case .blocked:
            return L10n.tr("setup.gatekeeper.title")
        case .installing:
            return L10n.tr("setup.install.installingTitle")
        default:
            return L10n.tr("setup.install.title")
        }
    }

    private var bodyText: String {
        switch model.content {
        case .blocked:
            return L10n.tr("setup.gatekeeper.body")
        default:
            return L10n.tr("setup.install.body")
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.content {
        case .blocked:
            gatekeeper
        case .install, .installing, .unverified, .installFailed:
            install
        }
    }

    // MARK: - Install / step 1

    @ViewBuilder
    private var install: some View {
        VStack(alignment: .leading, spacing: 12) {
            infoTable

            if case .unverified = model.content {
                Text(L10n.tr("setup.unverified.external"))
                    .font(typeSecondary)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if case .installing = model.content, let progress = model.progress {
                progressBlock(progress: progress)
            }

            if case .installFailed(let code) = model.content {
                Text(L10n.tr("setup.failed.\(code)"))
                    .font(typeSecondary)
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var infoTable: some View {
        VStack(spacing: 0) {
            tableRow(
                "setup.table.contents",
                value: versionText,
                monospaced: false
            )
            Divider().overlay(Theme.border)
            tableRow(
                "setup.table.size",
                value: SetupFormatting.aboutSize(model.driverInfo?.sizeBytes),
                monospaced: false
            )
            Divider().overlay(Theme.border)
            tableRow(
                "setup.table.location",
                value: locationText,
                monospaced: true
            )
            Divider().overlay(Theme.border)
            if case .unverified = model.content {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(Typography.sans(11))
                        .foregroundStyle(Theme.warning)
                    Text(L10n.tr("setup.unverified.warning"))
                        .font(typeSecondary)
                        .foregroundStyle(Theme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            } else {
                tableRow(
                    "setup.table.verification",
                    value: L10n.tr("setup.verification.value"),
                    monospaced: false
                )
            }
        }
        .background(Theme.background)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
    }

    private func tableRow(_ label: String, value: String, monospaced: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(L10n.tr(label))
                .font(typeTable)
                .foregroundStyle(Theme.secondary)
            Spacer(minLength: 0)
            Text(value)
                .font(monospaced ? typePath : typeTable)
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func progressBlock(progress: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.border)
                    Capsule()
                        .fill(Theme.primary)
                        .frame(width: geometry.size.width * CGFloat(progress) / 100)
                }
            }
            .frame(height: 6)

            HStack(spacing: 8) {
                Text(progress >= 100
                    ? L10n.tr("setup.progress.starting")
                    : SetupFormatting.downloadLine(
                        progress: progress,
                        totalBytes: model.driverInfo?.sizeBytes ?? 0
                    ))
                    .font(typeLabel)
                    .foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
                if progress < 100, let eta = SetupFormatting.etaText(model.eta) {
                    Text(eta)
                        .font(typeLabel)
                        .foregroundStyle(Theme.tertiary)
                }
            }
        }
    }

    private var versionText: String {
        let version = model.driverInfo?.version ?? "—"
        let key = model.driverInfo?.variant == "tuned"
            ? "setup.table.versionTuned"
            : "setup.table.versionOfficial"
        return L10n.format(key, version)
    }

    private var locationText: String {
        guard let dir = model.driverInfo?.installDir, !dir.isEmpty else { return "—" }
        return DriverPaths.abbreviateHome(dir)
    }

    // MARK: - Gatekeeper / step 2

    private var gatekeeper: some View {
        VStack(alignment: .leading, spacing: 10) {
            gatekeeperStep(1, "setup.gatekeeper.step1")
            gatekeeperStep(2, "setup.gatekeeper.step2", opensSettings: true)
            gatekeeperStep(3, "setup.gatekeeper.step3")
            pathBox
        }
    }

    private func gatekeeperStep(
        _ number: Int,
        _ key: String,
        opensSettings: Bool = false
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(String(number))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.accent)
                .frame(width: 20, height: 20)
                .background(Theme.stepIndex, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(L10n.tr(key))
                    .font(typeTable)
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                if opensSettings {
                    Button(action: actions.openPrivacySettings) {
                        Text(L10n.tr("setup.gatekeeper.openSettings"))
                            .font(typeSecondary)
                            .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(Theme.background, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
    }

    private var bundlePath: String? {
        guard let executable = model.driverInfo?.executable else { return nil }
        return DriverPaths.appBundle(fromExecutable: executable) ?? executable
    }

    private var pathBox: some View {
        HStack(spacing: 8) {
            Text(bundleDisplay)
                .font(typePath)
                .foregroundStyle(Theme.text)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
            Button(action: copyBundlePath) {
                Text(L10n.tr(copied ? "setup.button.copied" : "setup.button.copy"))
                    .font(Typography.sans(11))
                    .foregroundStyle(Theme.text)
                    .padding(.horizontal, 8)
                    .frame(height: 26)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(Theme.control, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
            .disabled(bundlePath == nil)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.inset, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
    }

    private var bundleDisplay: String {
        guard let path = bundlePath else { return "—" }
        return DriverPaths.abbreviateHome(path)
    }

    private func copyBundlePath() {
        guard let path = bundlePath else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(path, forType: .string)
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    // MARK: - Buttons

    @ViewBuilder
    private var buttons: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            switch model.content {
            case .blocked:
                secondaryButton("setup.button.showInFinder", action: showInFinder)
                primaryButton("setup.button.allowedRetry", action: actions.retry)
            case .installing:
                secondaryButton("setup.button.cancel", action: actions.cancel)
                primaryButton("setup.button.installing", action: {}, disabled: true, pressed: true)
            case .unverified:
                secondaryButton("setup.button.later", action: actions.later)
                primaryButton("setup.button.retry", action: actions.retry)
            case .installFailed:
                secondaryButton("setup.button.later", action: actions.later)
                primaryButton("setup.button.tryAgain", action: actions.install)
            case .install:
                secondaryButton("setup.button.later", action: actions.later)
                primaryButton("setup.button.install", action: actions.install)
            }
        }
    }

    private func showInFinder() {
        guard let path = bundlePath else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    private func primaryButton(
        _ key: String,
        action: @escaping () -> Void,
        disabled: Bool = false,
        pressed: Bool = false
    ) -> some View {
        Button(action: action) {
            Text(L10n.tr(key))
                .font(Typography.sans(13, .bold))
                .foregroundStyle(Theme.onPrimary)
                .padding(.horizontal, 16)
                .frame(height: 36)
                .background(
                    pressed ? Theme.primaryPressed : Theme.primary,
                    in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func secondaryButton(_ key: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(L10n.tr(key))
                .font(Typography.sans(13))
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 14)
                .frame(height: 36)
                .overlay(
                    RoundedRectangle(cornerRadius: 9, style: .continuous)
                        .stroke(Theme.control, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
