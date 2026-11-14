import Combine
import Foundation

/// What the setup window shows for the current driver state.
public enum SetupContent: Equatable, Sendable {
    case install
    case installing
    case unverified
    case installFailed(Int32)
    case blocked

    public static func needsDriver(progress: Int?, error: Int32, verified: Bool) -> SetupContent {
        if progress != nil {
            return .installing
        }
        if !verified {
            return .unverified
        }
        if (1...3).contains(error) {
            return .installFailed(error)
        }
        return .install
    }
}

/// Exponential moving average of download bytes/s. Hidden until the second
/// progress sample (one byte/time delta), because one sample has no rate.
public struct ProgressEstimator: Equatable, Sendable {
    public struct Estimate: Equatable, Sendable {
        public let bytesPerSecond: Double
        public let etaSeconds: Double
    }

    private var lastBytes: Double?
    private var lastTime: TimeInterval?
    private var rate: Double?

    public init() {}

    public var isReady: Bool { rate != nil }

    public mutating func sample(
        progress: Int,
        totalBytes: Int,
        time: TimeInterval
    ) -> Estimate? {
        guard totalBytes > 0 else { return nil }
        let bytes = Double(totalBytes) * Double(min(max(progress, 0), 100)) / 100
        defer {
            lastBytes = bytes
            lastTime = time
        }
        guard
            let previousBytes = lastBytes,
            let previousTime = lastTime,
            time > previousTime,
            bytes > previousBytes
        else {
            return nil
        }
        let instant = (bytes - previousBytes) / (time - previousTime)
        let smoothed = rate.map { $0 * 0.7 + instant * 0.3 } ?? instant
        rate = smoothed
        guard smoothed > 0 else { return nil }
        return Estimate(
            bytesPerSecond: smoothed,
            etaSeconds: (Double(totalBytes) - bytes) / smoothed
        )
    }
}

/// Formatting used by both the window and the panel cards. Sizes are decimal
/// megabytes, matching the board.
public enum SetupFormatting {
    public static func wholeMegabytes(_ bytes: Int?) -> String? {
        guard let bytes, bytes > 0 else { return nil }
        return String(format: "%.0f", Double(bytes) / 1_000_000)
    }

    public static func oneDecimalMegabytes(_ bytes: Double) -> String {
        String(format: "%.1f", max(0, bytes) / 1_000_000)
    }

    public static func aboutSize(_ bytes: Int?) -> String {
        guard let value = wholeMegabytes(bytes) else { return "—" }
        return L10n.format("setup.size.about", value)
    }

    public static func downloadLine(progress: Int, totalBytes: Int) -> String {
        let clamped = min(max(progress, 0), 100)
        let total = Double(max(totalBytes, 0))
        let downloaded = total * Double(clamped) / 100
        return L10n.format(
            "setup.progress.download",
            oneDecimalMegabytes(downloaded),
            wholeMegabytes(totalBytes) ?? "0"
        )
    }

    public static func etaText(_ seconds: Double?) -> String? {
        guard let seconds else { return nil }
        if seconds < 1 {
            return L10n.tr("setup.progress.etaLess")
        }
        return L10n.format("setup.progress.eta", Int(seconds.rounded()))
    }
}

/// Drives the setup window (PLAYER §4, §6). Pure decisions live here so the
/// XCTests can cover them without opening a window.
@MainActor
public final class SetupWindowModel: ObservableObject {
    @Published public private(set) var isOpen = false
    @Published public private(set) var step = 1
    @Published public private(set) var content: SetupContent = .install
    @Published public private(set) var progress: Int?
    @Published public private(set) var eta: Double?
    @Published public private(set) var driverInfo: DriverInfo?

    private var state: PanelState = .idle(failure: nil)
    private var playActive = false
    private var estimator = ProgressEstimator()

    public init() {}

    public var isInstalling: Bool { progress != nil }
    public var isVerified: Bool { driverInfo?.isVerified ?? false }

    /// Called when the user starts a play (URL or `.lep`); only then may
    /// NeedsDriver / Blocked pop the window automatically.
    public func notePlayRequest() {
        playActive = true
        if case .needsDriver = state {
            isOpen = true
        } else if case .blocked = state {
            isOpen = true
        }
    }

    public func apply(state: PanelState, driverInfo: DriverInfo?) {
        // Auto-open only when the state kind changes, so closing the window
        // during an install is not undone by the next progress event.
        let entering = !Self.sameKind(self.state, state)
        self.state = state
        self.driverInfo = driverInfo
        switch state {
        case .needsDriver(let value, let error):
            step = 1
            progress = value
            content = SetupContent.needsDriver(
                progress: value,
                error: error,
                verified: driverInfo?.isVerified ?? false
            )
            updateEstimate(progress: value)
            if playActive && entering {
                isOpen = true
            }
        case .blocked:
            step = 2
            progress = nil
            eta = nil
            estimator = ProgressEstimator()
            content = .blocked
            if playActive && entering {
                isOpen = true
            }
        case .playing, .idle:
            playActive = false
            progress = nil
            eta = nil
            estimator = ProgressEstimator()
            isOpen = false
        case .preparing:
            progress = nil
            eta = nil
            estimator = ProgressEstimator()
            isOpen = false
        case .coreUnavailable:
            progress = nil
            eta = nil
            estimator = ProgressEstimator()
            isOpen = false
        default:
            break
        }
    }

    public func show() {
        if case .blocked = state {
            step = 2
            content = .blocked
        }
        isOpen = true
    }

    public func close() {
        isOpen = false
    }

    private static func sameKind(_ lhs: PanelState, _ rhs: PanelState) -> Bool {
        switch (lhs, rhs) {
        case (.needsDriver, .needsDriver), (.blocked, .blocked):
            return true
        default:
            return lhs == rhs
        }
    }

    private func updateEstimate(progress: Int?) {
        guard let progress, let total = driverInfo?.sizeBytes, total > 0 else {
            eta = nil
            if progress == nil {
                estimator = ProgressEstimator()
            }
            return
        }
        if let estimate = estimator.sample(
            progress: progress,
            totalBytes: total,
            time: Date().timeIntervalSince1970
        ) {
            eta = estimate.etaSeconds
        }
    }
}
