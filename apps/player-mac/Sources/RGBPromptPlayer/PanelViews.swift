import AppKit
import PlayerKit
import SwiftUI
import UniformTypeIdentifiers

/// Actions owned by AppController; the panel only invokes them.
final class PanelActions {
    var openStudio: () -> Void = {}
    var openLibrary: () -> Void = {}
    var playPreset: (URL, String) -> Void = { _, _ in }
    var playLep: () -> Void = {}
    var makeDefault: () -> Void = {}
    var quit: () -> Void = {}
    var dropLep: (URL) -> Void = { _ in }
    var openKeySettings: () -> Void = {}
    var openAudioSettings: () -> Void = {}
    var openSetup: () -> Void = {}
    var installDriver: () -> Void = {}
    var declineDriver: () -> Void = {}
    var retryDriver: () -> Void = {}
    var selectKeyboard: (String) -> Void = { _ in }
    var openSupportedKeyboards: () -> Void = {}
    var openSettings: () -> Void = {}
    var openActivityMonitor: () -> Void = {}
    var hidePanel: () -> Void = {}
    var activityMonitorAvailable = false
}

/// Panel-only metrics and surfaces (tmp/player-redesign/spec.md §5).
private enum PanelStyle {
    static let width: CGFloat = 340
    static let raised = Color(hex: 0x1B202B)
    static let hover = Color(hex: 0x222835)
    static let keyBase = Color(hex: 0x12161F)
    static let keyIdle = Color(hex: 0x1A1F2A)
    static let keyOutline = Color(hex: 0x262C39)
    static let body = Typography.sans(13)
    static let bodyStrong = Typography.sans(13, .semibold)
    static let button = Typography.sans(14, .semibold)
    static let name = Typography.sans(15, .semibold)
    static let meta = Typography.sans(12)
    static let small = Typography.sans(11)
    static let keyboardAspect = CGFloat(KeyLayout.maxX / KeyLayout.maxY)
}

private enum InputChip: Equatable {
    case audio
    case keyOff
    case audioOff
}

struct PanelRootView: View {
    @ObservedObject var bridge: PlayerCoreBridge
    @ObservedObject var poller: PreviewPoller
    @ObservedObject var handler: DefaultHandlerCoordinator
    @ObservedObject var input: InputCoordinator
    @ObservedObject var setup: SetupWindowModel
    @ObservedObject var panelModel: PanelModel
    @ObservedObject var language: LanguageStore
    @ObservedObject var ui: PanelUIState
    let actions: PanelActions

    @State private var diagnosticsCopied = false
    @State private var dropTargeted = false
    @State private var presets: [PlayerPreset] = PresetCatalog.load()
    @State private var noticeExpanded = false
    @State private var highlighted: Int?
    @FocusState private var pickerFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if ui.pickerOpen && showsSelector {
                picker
            } else {
                content
            }
            if panelModel.hasConflictHint {
                Text(L10n.format("panel.footer.reopenVendors", panelModel.conflicts.displayNames))
                    .font(PanelStyle.small)
                    .foregroundStyle(Theme.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
        }
        .frame(width: PanelStyle.width, alignment: .leading)
        .background(Theme.background)
        .background(shortcuts)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(
                    dropTargeted ? Theme.text.opacity(0.55) : Theme.border,
                    lineWidth: dropTargeted ? 1.5 : 1
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onDrop(of: [UTType.fileURL], isTargeted: $dropTargeted, perform: acceptDrop)
        .environment(\.colorScheme, .dark)
        .onChange(of: inputChip) { _, chip in
            if chip == nil || chip == .audio { noticeExpanded = false }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 4) {
            HStack(spacing: 8) {
                Image("PanelMark")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 18, height: 18)
                    .accessibilityHidden(true)
                Text(verbatim: "RGBPrompt")
                    .font(Typography.sans(13, .semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 6, height: 6)
                    Text(headerStatusText)
                        .font(PanelStyle.meta)
                        .foregroundStyle(Theme.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(minWidth: 0, alignment: .trailing)
                        .layoutPriority(0)
                        .help(headerStatusText)
                }
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .trailing)
                .layoutPriority(0)
            }
            // The whole 48-point header, except the ⋯ / × buttons beside
            // this stack, is the window drag region. Fill the header height so
            // the overlay is not limited to the logo/text's intrinsic height.
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .overlay {
                WindowDragArea()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityHidden(true)
            }

            HStack(spacing: 6) {
                moreMenu
                closeButton
            }
            .padding(.leading, 4)
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(height: 48)
    }

    /// Same button style as the close button; the menu itself is a native
    /// NSMenu popped under the button (a SwiftUI `Menu` label gets template-tinted
    /// by AppKit and turned black).
    private var moreMenu: some View {
        Button(action: showMoreMenu) {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Theme.secondary)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(HeaderIconButtonStyle())
        .help(L10n.tr("panel.more"))
        .accessibilityLabel(L10n.tr("panel.more"))
    }

    private func showMoreMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.appearance = NSAppearance(named: .darkAqua)
        menu.addItem(ClosureMenuItem(L10n.tr("panel.footer.playLep"), key: "o", action: actions.playLep))
        menu.addItem(ClosureMenuItem(L10n.tr("panel.footer.settings"), key: ",", action: actions.openSettings))
        if handler.showsDefaultHandlerPrompt {
            menu.addItem(.separator())
            menu.addItem(ClosureMenuItem(L10n.tr("panel.footer.defaultHandler"), action: actions.makeDefault))
        }

        let keyboards = bridge.refreshKeyboards()
        if keyboards.count > 1 {
            menu.addItem(.separator())
            let header = NSMenuItem(title: L10n.tr("panel.more.keyboards"), action: nil, keyEquivalent: "")
            header.isEnabled = false
            menu.addItem(header)
            let current = bridge.keyboardName
            for keyboard in keyboards {
                let title = Self.shortKeyboardName(keyboard.name)
                let item = ClosureMenuItem(title.isEmpty ? keyboard.name : title) { [actions] in
                    actions.selectKeyboard(keyboard.name)
                }
                item.state = keyboard.name == current ? .on : .off
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(L10n.tr("panel.footer.quit"), key: "q", action: actions.quit))
        let location = NSEvent.mouseLocation
        menu.popUp(positioning: nil, at: NSPoint(x: location.x - 8, y: location.y - 10), in: nil)
    }

    private var closeButton: some View {
        Button(action: actions.hidePanel) {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Theme.secondary)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(HeaderIconButtonStyle())
        .help(L10n.tr("panel.hide"))
        .accessibilityLabel(L10n.tr("panel.hide"))
    }

    /// ⌘O / ⌘, / ⌘Q keep working although their rows moved into the ⋯ menu.
    private var shortcuts: some View {
        ZStack {
            Button("", action: actions.playLep).keyboardShortcut("o", modifiers: .command)
            Button("", action: actions.openSettings).keyboardShortcut(",", modifiers: .command)
            Button("", action: actions.quit).keyboardShortcut("q", modifiers: .command)
        }
        .buttonStyle(.plain)
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private var issue: BackendIssue? {
        BackendIssue.from(state: bridge.state, driverInfo: bridge.driverInfo)
    }

    private var headerStatusText: String {
        if let issue { return L10n.tr(issue.headerStatusKey) }
        switch bridge.state {
        case .playing, .idle, .preparing:
            let name = Self.shortKeyboardName(bridge.keyboardName)
            return name.isEmpty ? L10n.tr("panel.status.ready") : name
        default:
            return L10n.tr(bridge.state.headerStatusKey)
        }
    }

    /// OpenRGB names often end in a USB id ("EVision Keyboard 320F:5000 …");
    /// the header only needs the readable part.
    static func shortKeyboardName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = trimmed.range(
            of: #"\s+[0-9A-Fa-f]{4}:[0-9A-Fa-f]{4}.*$"#,
            options: .regularExpression
        ) else {
            return trimmed
        }
        return String(trimmed[..<range.lowerBound])
    }

    private var statusColor: Color {
        switch bridge.state {
        case .playing:
            return Theme.primary
        case .idle(let failure):
            return failure == nil ? Theme.tertiary : Theme.warning
        case .preparing:
            return Theme.tertiary
        case .coreUnavailable:
            return Theme.danger
        default:
            return Theme.warning
        }
    }

    // MARK: - Content

    /// Idle, preparing and playing share the now-playing layout; every other
    /// state shows its card and hides the effect picker (no keyboard to play on).
    private var showsSelector: Bool {
        switch bridge.state {
        case .idle, .playing, .preparing: return true
        default: return false
        }
    }

    @ViewBuilder
    private var content: some View {
        Group {
            switch bridge.state {
            case .playing, .idle, .preparing:
                nowPlaying
            case .needsDriver(let progress, let driverError):
                needsDriverCard(progress: progress, driverError: driverError)
            case .noKeyboard(let deviceLost):
                noKeyboardCard(deviceLost: deviceLost)
            case .backendUnresponsive:
                backendCard(issue: issue ?? .unresponsive)
            case .vendorConflict(let name):
                vendorCard(name: name)
            case .blocked:
                blockedCard()
            case .coreUnavailable:
                coreUnavailableCard
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
    }

    private var isPlaying: Bool { bridge.state.isPlaying }

    private var isPreparing: Bool {
        if case .preparing = bridge.state { return true }
        return false
    }

    private var idleFailure: FailureCode? {
        if case .idle(let failure) = bridge.state, let failure, failure != .driverDeclined {
            return failure
        }
        return nil
    }

    private var nowPlaying: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let idleFailure {
                failureCard(idleFailure)
            } else {
                hero
            }
            if let chip = inputChip {
                HStack {
                    Spacer(minLength: 0)
                    chipView(chip)
                }
                .padding(.top, 8)
            }
            noticeDetail
            selectorRow
                .padding(.top, 12)
            if bridge.stoppedByUser && !isPlaying && !isPreparing {
                Text(L10n.tr("panel.stoppedHint"))
                    .font(PanelStyle.small)
                    .foregroundStyle(Theme.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                    .padding(.horizontal, 2)
            }
        }
    }

    // MARK: - Hero (live keyboard)

    private var hero: some View {
        ZStack {
            KeyboardCanvas(rgb: isPlaying ? (poller.frame?.rgb ?? []) : [], outline: !isPlaying)
                .aspectRatio(PanelStyle.keyboardAspect, contentMode: .fit)
                .padding(10)
            if !isPlaying && !dropTargeted {
                Theme.inset.opacity(0.55)
                if isPreparing {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text(L10n.tr("panel.preparing"))
                            .font(PanelStyle.meta)
                            .foregroundStyle(Theme.secondary)
                    }
                } else {
                    VStack(spacing: 6) {
                        Image(systemName: "doc")
                            .font(.system(size: 13, weight: .regular))
                            .foregroundStyle(Theme.tertiary)
                        Text(L10n.tr("panel.idle.dropHere"))
                            .font(PanelStyle.meta)
                            .foregroundStyle(Theme.secondary)
                    }
                }
            }
            if dropTargeted {
                Theme.inset.opacity(0.78)
                Text(L10n.tr("panel.drop.release"))
                    .font(PanelStyle.bodyStrong)
                    .foregroundStyle(Theme.text)
            }
        }
        .frame(maxWidth: .infinity)
        .background(Theme.inset, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Theme.border, lineWidth: 1)
        )
    }

    // MARK: - Input chip (below the keyboard, never over it)

    private var inputChip: InputChip? {
        guard isPlaying else { return nil }
        if let notice = input.keyNotice, notice != .explain { return .keyOff }
        if input.audioNotice != nil { return .audioOff }
        if input.audioWanted { return .audio }
        return nil
    }

    @ViewBuilder
    private func chipView(_ chip: InputChip) -> some View {
        HStack(spacing: 6) {
            switch chip {
            case .audio:
                LevelBars(level: input.level)
                Text(L10n.tr("panel.chip.audio"))
                    .foregroundStyle(Theme.secondary)
            case .keyOff, .audioOff:
                Text(L10n.tr(chip == .keyOff ? "panel.chip.keyOff" : "panel.chip.audioOff"))
                    .foregroundStyle(Theme.warning)
                Button {
                    noticeExpanded.toggle()
                } label: {
                    Text(L10n.tr("panel.chip.enable"))
                        .foregroundStyle(Theme.text)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .font(PanelStyle.small)
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(PanelStyle.raised, in: Capsule())
        .overlay(
            Capsule().stroke(
                chip == .audio ? Theme.border : Theme.warning.opacity(0.35),
                lineWidth: 1
            )
        )
    }

    @ViewBuilder
    private var noticeDetail: some View {
        if isPlaying, let notice = input.keyNotice, notice == .explain || noticeExpanded {
            keyNoticeCard(notice)
                .padding(.top, 8)
        } else if isPlaying, noticeExpanded, let notice = input.audioNotice {
            audioNoticeCard(notice)
                .padding(.top, 8)
        }
    }

    // MARK: - Selector row

    private var currentPreset: PlayerPreset? {
        if case .preset(let id) = bridge.playSource {
            return presets.first { $0.id == id }
        }
        return nil
    }

    private var currentName: String {
        if let currentPreset {
            return PresetCatalog.displayName(currentPreset, language: language.effective.rawValue)
        }
        return bridge.effectName.isEmpty ? L10n.tr("panel.untitled") : bridge.effectName
    }

    private var sourceText: String {
        switch bridge.playSource {
        case .preset: return L10n.tr("panel.source.preset")
        case .web: return L10n.tr("panel.source.web")
        case .file, .none: return L10n.tr("panel.source.file")
        }
    }

    private var showsEffect: Bool {
        isPlaying || (isPreparing && bridge.playSource != .none)
    }

    private var selectorRow: some View {
        HStack(spacing: 8) {
            Button(action: openPicker) {
                if showsEffect {
                    effectLabel
                } else {
                    chooseLabel
                }
            }
            .buttonStyle(PanelRowStyle(
                fill: showsEffect ? PanelStyle.raised : Theme.text,
                hoverFill: showsEffect ? PanelStyle.hover : Theme.text.opacity(0.9),
                stroke: showsEffect ? Theme.border : .clear
            ))
            .accessibilityLabel(L10n.tr("panel.picker.choose"))

            if isPlaying {
                Button {
                    _ = bridge.stop()
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 11, weight: .regular))
                        .foregroundStyle(Theme.secondary)
                        .frame(width: 44, height: 56)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PanelRowStyle(fill: .clear, hoverFill: PanelStyle.hover, stroke: Theme.border))
                .help(L10n.tr("panel.stop"))
                .accessibilityLabel(L10n.tr("panel.stop"))
            }
        }
    }

    private var effectLabel: some View {
        HStack(spacing: 12) {
            KeySwatch(rgb: poller.frame?.rgb ?? currentPreset?.thumbnail ?? [])
                .frame(width: 32, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(currentName)
                    .font(PanelStyle.name)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                Text(sourceText)
                    .font(PanelStyle.meta)
                    .foregroundStyle(Theme.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity)
        .frame(height: 56)
        .contentShape(Rectangle())
    }

    private var chooseLabel: some View {
        HStack(spacing: 8) {
            Text(L10n.tr("panel.picker.choose"))
                .font(PanelStyle.button)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(Theme.background)
        .frame(maxWidth: .infinity)
        .frame(height: 44)
        .contentShape(Rectangle())
    }

    private func openPicker() {
        highlighted = presets.firstIndex { $0.id == currentPreset?.id }
        ui.pickerOpen = true
    }

    // MARK: - Picker

    private var picker: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Button {
                    ui.pickerOpen = false
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.secondary)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n.tr("panel.picker.choose"))
                Text(L10n.tr("panel.picker.choose"))
                    .font(PanelStyle.bodyStrong)
                    .foregroundStyle(Theme.text)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)
            .frame(height: 36)

            ForEach(Array(presets.enumerated()), id: \.element.id) { index, preset in
                presetRow(preset, index: index)
            }

            Rectangle()
                .fill(Theme.border)
                .frame(height: 1)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)

            pickerAction("doc", L10n.tr("panel.footer.playLep"), shortcut: "⌘O") {
                ui.pickerOpen = false
                actions.playLep()
            }
            pickerAction("arrow.up.right", L10n.tr("panel.picker.create")) {
                actions.openLibrary()
            }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
        .focusable()
        .focusEffectDisabled()
        .focused($pickerFocused)
        .onKeyPress(.upArrow) { moveHighlight(-1); return .handled }
        .onKeyPress(.downArrow) { moveHighlight(1); return .handled }
        .onKeyPress(.return) {
            if let highlighted, presets.indices.contains(highlighted) {
                play(presets[highlighted])
            }
            return .handled
        }
        .onAppear { pickerFocused = true }
    }

    private func moveHighlight(_ delta: Int) {
        guard !presets.isEmpty else { return }
        let start = highlighted ?? (delta > 0 ? -1 : presets.count)
        highlighted = min(max(start + delta, 0), presets.count - 1)
    }

    private func play(_ preset: PlayerPreset) {
        guard let url = preset.fileURL else { return }
        ui.pickerOpen = false
        actions.playPreset(url, preset.id)
    }

    private func presetRow(_ preset: PlayerPreset, index: Int) -> some View {
        let current = currentPreset?.id == preset.id && (isPlaying || isPreparing)
        let fill: Color = highlighted == index ? PanelStyle.hover : (current ? PanelStyle.raised : .clear)
        return Button {
            play(preset)
        } label: {
            HStack(spacing: 12) {
                KeySwatch(rgb: preset.thumbnail)
                    .frame(width: 28, height: 18)
                Text(PresetCatalog.displayName(preset, language: language.effective.rawValue))
                    .font(PanelStyle.body)
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if preset.hasAudio {
                    Image(systemName: "waveform")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.tertiary)
                }
                if preset.needsKeys {
                    Image(systemName: "keyboard")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.tertiary)
                }
                if current {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.primary)
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 36)
            .background(fill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(preset.fileURL == nil)
        .onHover { inside in
            if inside { highlighted = index }
        }
    }

    private func pickerAction(
        _ symbol: String,
        _ title: String,
        shortcut: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.tertiary)
                    .frame(width: 28)
                Text(title)
                    .font(PanelStyle.body)
                    .foregroundStyle(Theme.secondary)
                Spacer(minLength: 0)
                if let shortcut {
                    Text(shortcut)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.tertiary)
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(PanelRowStyle(fill: .clear, hoverFill: PanelStyle.hover, stroke: .clear, radius: 8))
    }

    // MARK: - Input notices

    @ViewBuilder
    private func keyNoticeCard(_ notice: InputCoordinator.KeyNotice) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            switch notice {
            case .explain:
                Text(L10n.tr("panel.input.key.explain.title"))
                    .font(Typography.bodyStrong)
                    .foregroundStyle(Theme.text)
                Text(L10n.tr("panel.input.key.explain.body"))
                    .font(Typography.caption)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    primaryButton("panel.input.continue") {
                        input.continueAfterKeyExplanation()
                    }
                    secondaryButton("panel.input.notNow") {
                        input.notNowKeyExplanation()
                    }
                }
            case .denied:
                Text(L10n.tr("panel.input.key.denied.title"))
                    .font(Typography.captionStrong)
                    .foregroundStyle(Theme.warning)
                Text(L10n.tr("panel.input.key.path"))
                    .font(Typography.footnote)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                secondaryButton("panel.input.openSettings") {
                    actions.openKeySettings()
                }
            case .needsRelaunch:
                Text(L10n.tr("panel.input.key.relaunch"))
                    .font(Typography.caption)
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                secondaryButton("panel.input.key.quit") {
                    actions.quit()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(
            Theme.warning.opacity(0.12),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Theme.warning.opacity(0.45), lineWidth: 1)
        )
    }

    private func audioNoticeCard(_: InputCoordinator.AudioNotice) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(L10n.tr("panel.input.audio.title"))
                .font(Typography.captionStrong)
                .foregroundStyle(Theme.warning)
            Text(L10n.tr("panel.input.audio.path"))
                .font(Typography.footnote)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            secondaryButton("panel.input.openSettings") {
                actions.openAudioSettings()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(
            Theme.warning.opacity(0.12),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Theme.warning.opacity(0.45), lineWidth: 1)
        )
    }

    private func failureCard(_ failure: FailureCode) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(L10n.tr("panel.failure.title"))
                .font(Typography.headline)
                .foregroundStyle(Theme.text)
            Text(L10n.tr("panel.failure.line"))
                .font(Typography.caption)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n.tr(failure.localizationKey))
                .font(Typography.caption)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                primaryButton("panel.createEffect") {
                    actions.openLibrary()
                }
                secondaryButton("panel.backend.copyDiagnostics") {
                    copyDiagnostics()
                }
            }
            if diagnosticsCopied {
                Text(L10n.tr("panel.backend.copied"))
                    .font(Typography.footnote)
                    .foregroundStyle(Theme.primary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(Theme.danger.opacity(0.10), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Theme.danger.opacity(0.45), lineWidth: 1)
        )
    }

    private func needsDriverCard(progress: Int?, driverError: Int32) -> some View {
        let info = bridge.driverInfo
        let content = SetupContent.needsDriver(
            progress: progress,
            error: driverError,
            verified: info?.isVerified ?? false
        )
        return VStack(alignment: .leading, spacing: 9) {
            Text(L10n.tr("panel.needsDriver.title"))
                .font(Typography.headline)
                .foregroundStyle(Theme.text)
            Text(L10n.tr("panel.needsDriver.body"))
                .font(Typography.body)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 5) {
                if let megabytes = SetupFormatting.wholeMegabytes(info?.sizeBytes) {
                    bulletRow(
                        "panel.needsDriver.bullet.summary",
                        values: [info?.version ?? "—", megabytes]
                    )
                } else {
                    bulletRow(
                        "panel.needsDriver.bullet.versionOnly",
                        values: [info?.version ?? "—"]
                    )
                }
                bulletKey("panel.needsDriver.bullet.verified")
                bulletKey("panel.needsDriver.bullet.safe")
            }

            if let progress {
                VStack(alignment: .leading, spacing: 4) {
                    ProgressView(value: Double(progress), total: 100)
                        .tint(Theme.primary)
                    Text(L10n.format("panel.needsDriver.percent", progress))
                        .font(Typography.footnote.monospacedDigit())
                        .foregroundStyle(Theme.secondary)
                }
            }

            switch content {
            case .unverified:
                Text(L10n.tr("setup.unverified.warning"))
                    .font(Typography.caption)
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                Text(L10n.tr("setup.unverified.external"))
                    .font(Typography.footnote)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    primaryButton("setup.button.retry") {
                        actions.retryDriver()
                    }
                    secondaryButton("panel.needsDriver.later") {
                        actions.declineDriver()
                    }
                }
            case .installFailed(let code):
                Text(L10n.tr("setup.failed.\(code)"))
                    .font(Typography.caption)
                    .foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    primaryButton("setup.button.tryAgain") {
                        actions.installDriver()
                    }
                    secondaryButton("panel.needsDriver.later") {
                        actions.declineDriver()
                    }
                }
            case .installing:
                HStack(spacing: 8) {
                    primaryButton("setup.button.installing", action: {}, disabled: true, pressed: true)
                    secondaryButton("setup.button.cancel") {
                        _ = bridge.stop()
                    }
                }
            case .install, .blocked:
                HStack(spacing: 8) {
                    primaryButton("panel.needsDriver.install") {
                        actions.installDriver()
                    }
                    secondaryButton("panel.needsDriver.later") {
                        actions.declineDriver()
                    }
                }
            }
        }
        .panelCard()
    }

    private func noKeyboardCard(deviceLost: Bool) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            if deviceLost {
                Text(L10n.tr("panel.noKeyboard.deviceLost"))
                    .font(Typography.captionStrong)
                    .foregroundStyle(Theme.warning)
            }
            Text(L10n.tr("panel.noKeyboard.title"))
                .font(Typography.headline)
                .foregroundStyle(Theme.text)
            Text(L10n.tr("panel.noKeyboard.subtitle"))
                .font(Typography.body)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                stepRow(1, "panel.noKeyboard.check1")
                stepRow(2, "panel.noKeyboard.check2")
                stepRow(3, "panel.noKeyboard.check3")
            }

            HStack(spacing: 8) {
                primaryButton("panel.noKeyboard.findAgain") {
                    _ = bridge.retry()
                }
                secondaryButton("panel.noKeyboard.supported") {
                    actions.openSupportedKeyboards()
                }
            }

            Text(L10n.tr("panel.noKeyboard.footer"))
                .font(Typography.footnote)
                .foregroundStyle(Theme.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .panelCard()
    }

    private func backendCard(issue: BackendIssue) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            switch issue {
            case .restarting(let attempt, let limit):
                Text(L10n.tr("panel.backend.restarting.title"))
                    .font(Typography.headline)
                    .foregroundStyle(Theme.text)
                Text(L10n.format("panel.backend.restarting.body", attempt, limit))
                    .font(Typography.body)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ProgressView()
                    .controlSize(.small)
                secondaryButton("panel.backend.copyDiagnostics") {
                    copyDiagnostics()
                }
            case .gaveUp:
                Text(L10n.tr("panel.backend.gaveUp.title"))
                    .font(Typography.headline)
                    .foregroundStyle(Theme.text)
                Text(L10n.format("panel.backend.gaveUp.body", max(1, attemptCount(issue))))
                    .font(Typography.body)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                actionRow(
                    primary: "panel.backend.restart",
                    primaryAction: { _ = bridge.restartBackend() },
                    secondary: "panel.backend.copyDiagnostics",
                    secondaryAction: copyDiagnostics
                )
            case .externalLost(let port):
                Text(L10n.tr("panel.backend.external.title"))
                    .font(Typography.headline)
                    .foregroundStyle(Theme.text)
                Text(L10n.format("panel.backend.external.body", String(port)))
                    .font(Typography.body)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 7) {
                    ProgressView()
                        .controlSize(.mini)
                    Text(L10n.tr("panel.backend.waiting"))
                        .font(Typography.caption)
                        .foregroundStyle(Theme.secondary)
                }
                actionRow(
                    primary: "panel.backend.retryNow",
                    primaryAction: { _ = bridge.retry() },
                    secondary: "panel.backend.copyDiagnostics",
                    secondaryAction: copyDiagnostics
                )
            case .unresponsive:
                Text(L10n.tr("panel.backend.unresponsive.title"))
                    .font(Typography.headline)
                    .foregroundStyle(Theme.text)
                Text(L10n.tr("panel.backend.unresponsive.body"))
                    .font(Typography.body)
                    .foregroundStyle(Theme.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                actionRow(
                    primary: "panel.backend.restart",
                    primaryAction: { _ = bridge.restartBackend() },
                    secondary: "panel.backend.copyDiagnostics",
                    secondaryAction: copyDiagnostics
                )
            }

            if diagnosticsCopied {
                Text(L10n.tr("panel.backend.copied"))
                    .font(Typography.footnote)
                    .foregroundStyle(Theme.primary)
            }
        }
        .panelCard()
    }

    private func attemptCount(_ issue: BackendIssue) -> Int {
        if case .restarting(let attempt, _) = issue { return attempt }
        return bridge.driverInfo?.supervision?.crashes ?? 1
    }

    private func vendorCard(name: String?) -> some View {
        let displayName = name ?? L10n.tr("panel.vendor.fallbackName")
        return VStack(alignment: .leading, spacing: 9) {
            Text(L10n.format("panel.vendor.title", displayName))
                .font(Typography.headline)
                .foregroundStyle(Theme.text)
            Text(L10n.tr("panel.vendor.body"))
                .font(Typography.body)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 6) {
                stepText(1, L10n.format("panel.vendor.step1", displayName))
                stepText(2, L10n.tr("panel.vendor.step2"))
                stepText(3, L10n.tr("panel.vendor.step3"))
            }

            HStack(spacing: 8) {
                primaryButton("panel.vendor.retry") {
                    _ = bridge.retry()
                }
                if actions.activityMonitorAvailable {
                    secondaryButton("panel.vendor.openActivityMonitor") {
                        actions.openActivityMonitor()
                    }
                }
            }

            Button(action: copyDiagnostics) {
                Text(L10n.tr(diagnosticsCopied
                    ? "panel.backend.copied"
                    : "panel.backend.copyDiagnostics"))
                    .font(Typography.caption)
                    .foregroundStyle(Theme.accent)
            }
            .buttonStyle(.plain)
        }
        .panelCard()
    }

    private func blockedCard() -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(L10n.tr("panel.blocked.title"))
                .font(Typography.headline)
                .foregroundStyle(Theme.text)
            Text(L10n.tr("panel.blocked.line"))
                .font(Typography.body)
                .foregroundStyle(Theme.secondary)
            // Stacked: the retry label is too long for a half-width button.
            VStack(spacing: 8) {
                primaryButton("panel.blocked.retry") {
                    _ = bridge.retry()
                }
                secondaryButton("panel.blocked.showSteps", action: actions.openSetup)
            }
        }
        .panelCard()
    }

    private var coreUnavailableCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(L10n.tr("panel.coreUnavailable.title"))
                .font(Typography.title)
                .foregroundStyle(Theme.text)
            Text(L10n.tr("panel.coreUnavailable.body"))
                .font(Typography.caption)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .panelCard()
    }

    // MARK: - Pieces

    private func primaryButton(
        _ key: String,
        action: @escaping () -> Void,
        disabled: Bool = false,
        pressed: Bool = false
    ) -> some View {
        Button(action: action) {
            Text(L10n.tr(key))
                .font(Typography.bodyStrong)
                .foregroundStyle(Theme.onPrimary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(
                    pressed ? Theme.primaryPressed : Theme.primary,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func secondaryButton(_ key: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(L10n.tr(key))
                .font(Typography.body)
                .foregroundStyle(Theme.text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Theme.control, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private func actionRow(
        primary: String,
        primaryAction: @escaping () -> Void,
        secondary: String,
        secondaryAction: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 8) {
            primaryButton(primary, action: primaryAction)
            secondaryButton(secondary, action: secondaryAction)
        }
    }

    private func bulletRow(_ key: String, values: [String]) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(Theme.primary)
                .frame(width: 4, height: 4)
            Text(L10n.format(key, arguments: values))
                .font(Typography.footnote)
                .foregroundStyle(Theme.secondary)
                .lineLimit(1)
        }
    }

    private func bulletKey(_ key: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle()
                .fill(Theme.primary)
                .frame(width: 4, height: 4)
            Text(L10n.tr(key))
                .font(Typography.footnote)
                .foregroundStyle(Theme.secondary)
                .lineLimit(1)
        }
    }

    private func stepRow(_ number: Int, _ key: String) -> some View {
        stepText(number, L10n.tr(key))
    }

    private func stepText(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Text(String(number))
                .font(Typography.footnoteStrong)
                .foregroundStyle(Theme.accent)
                .frame(width: 15, height: 15)
                .background(Theme.stepIndex, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            Text(text)
                .font(Typography.caption)
                .foregroundStyle(Theme.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func copyDiagnostics() {
        let copier = DiagnosticsCopier(
            source: bridge,
            config: bridge.config,
            protocolRegistered: handler.isDefaultForScheme
        )
        guard copier.copy() else { return }
        diagnosticsCopied = true
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            diagnosticsCopied = false
        }
    }

    private func acceptDrop(_ providers: [NSItemProvider]) -> Bool {
        guard let provider = providers.first else { return false }
        provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
            let url: URL?
            if let data = item as? Data {
                url = URL(dataRepresentation: data, relativeTo: nil)
            } else {
                url = item as? URL
            }
            guard let url, url.pathExtension.lowercased() == "lep" else { return }
            Task { @MainActor in
                actions.dropLep(url)
            }
        }
        return true
    }
}

private struct LevelBars: View {
    let level: Float

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<5, id: \.self) { index in
                let threshold = Float(index + 1) / 5
                Capsule()
                    .fill(level >= threshold ? Theme.primary : Theme.border)
                    .frame(width: 3, height: CGFloat(4 + index * 2))
            }
        }
        .frame(height: 14, alignment: .bottom)
    }
}

/// NSMenuItem that runs a closure; shortcuts are shown as hints only (the
/// panel's hidden buttons own ⌘O / ⌘, / ⌘Q).
private final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, key: String = "", action handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: key)
        target = self
        keyEquivalentModifierMask = key.isEmpty ? [] : .command
    }

    required init(coder: NSCoder) {
        fatalError("unused")
    }

    @objc private func run() {
        handler()
    }
}

/// Title-bar icon buttons (⋯ and ×): an always-visible soft tile so they read
/// as clickable, brighter on hover, darker when pressed.
private struct HeaderIconChrome: ViewModifier {
    var pressed = false
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .background(
                pressed ? Theme.border : (hovering ? PanelStyle.hover : PanelStyle.raised),
                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(hovering ? Color(hex: 0x3A4150) : Theme.border, lineWidth: 1)
            )
            .onHover { hovering = $0 }
    }
}

private struct HeaderIconButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .modifier(HeaderIconChrome(pressed: configuration.isPressed))
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
    }
}

/// Row button: flat fill, a hover fill and a light press.
private struct PanelRowStyle: ButtonStyle {
    let fill: Color
    let hoverFill: Color
    let stroke: Color
    var radius: CGFloat = 10

    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration, style: self)
    }

    private struct RowBody: View {
        let configuration: ButtonStyleConfiguration
        let style: PanelRowStyle
        @State private var hovering = false

        var body: some View {
            configuration.label
                .background(
                    hovering ? style.hoverFill : style.fill,
                    in: RoundedRectangle(cornerRadius: style.radius, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: style.radius, style: .continuous)
                        .stroke(style.stroke, lineWidth: 1)
                )
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .onHover { hovering = $0 }
        }
    }
}

/// The full 104-key keyboard, WYSIWYG with the frame the core sends.
private struct KeyboardCanvas: View {
    let rgb: [UInt8]
    var outline = false

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width / KeyLayout.maxX, size.height / KeyLayout.maxY)
            let originX = (size.width - KeyLayout.maxX * scale) / 2
            let originY = (size.height - KeyLayout.maxY * scale) / 2
            let gap = max(1, scale * 0.1)
            let radius = max(1, min(2.5, scale * 0.15))
            for (index, key) in KeyLayout.keys.enumerated() {
                let rect = CGRect(
                    x: originX + CGFloat(key.x) * scale + gap / 2,
                    y: originY + CGFloat(key.y) * scale + gap / 2,
                    width: CGFloat(key.w) * scale - gap,
                    height: CGFloat(key.h) * scale - gap
                )
                let path = Path(roundedRect: rect, cornerRadius: radius)
                if outline {
                    context.fill(path, with: .color(PanelStyle.keyIdle))
                    context.stroke(path, with: .color(PanelStyle.keyOutline), lineWidth: 1)
                    continue
                }
                // Unlit keys keep a faint cap so the keyboard still reads.
                context.fill(path, with: .color(PanelStyle.keyBase))
                let offset = index * 3
                guard offset + 2 < rgb.count else { continue }
                var lit = context
                lit.blendMode = .plusLighter
                lit.fill(path, with: .color(Color(
                    red: Double(rgb[offset]) / 255,
                    green: Double(rgb[offset + 1]) / 255,
                    blue: Double(rgb[offset + 2]) / 255
                )))
            }
        }
    }
}

/// A soft colour strip of an effect frame: the whole keyboard, stretched to
/// the swatch and blurred, so it reads as the effect's palette, not a mosaic.
private struct KeySwatch: View {
    let rgb: [UInt8]

    private var average: Color {
        let count = rgb.count / 3
        guard count > 0 else { return Theme.inset }
        var sum = (0, 0, 0)
        for index in 0..<count {
            sum.0 += Int(rgb[index * 3])
            sum.1 += Int(rgb[index * 3 + 1])
            sum.2 += Int(rgb[index * 3 + 2])
        }
        return Color(
            red: Double(sum.0) / Double(count) / 255,
            green: Double(sum.1) / Double(count) / 255,
            blue: Double(sum.2) / Double(count) / 255
        )
    }

    var body: some View {
        Canvas { context, size in
            // Gaps between key blocks take the average colour, not black.
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(average))
            let scaleX = size.width / KeyLayout.maxX
            let scaleY = size.height / KeyLayout.maxY
            for (index, key) in KeyLayout.keys.enumerated() {
                let offset = index * 3
                guard offset + 2 < rgb.count else { continue }
                let rect = CGRect(
                    x: CGFloat(key.x) * scaleX,
                    y: CGFloat(key.y) * scaleY,
                    width: CGFloat(key.w) * scaleX + 0.5,
                    height: CGFloat(key.h) * scaleY + 0.5
                )
                context.fill(Path(rect), with: .color(Color(
                    red: Double(rgb[offset]) / 255,
                    green: Double(rgb[offset + 1]) / 255,
                    blue: Double(rgb[offset + 2]) / 255
                )))
            }
        }
        .blur(radius: 2.5, opaque: true)
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .stroke(Theme.text.opacity(0.08), lineWidth: 1)
        )
    }
}

private extension View {
    func panelCard() -> some View {
        padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Theme.border, lineWidth: 1)
            )
    }
}
