import Darwin

/// Lock-free peak meter for the sound-source row. The audio thread calls
/// `record`, which only does atomic compare-and-swap; the UI reads
/// `snapshot` at 5 Hz and applies a visual decay.
public final class LevelMeter: @unchecked Sendable {
    private let peakBits: UnsafeMutablePointer<Int32>
    private let decay: Float
    @MainActor private var lastDisplayed: Float = 0

    public init(decay: Float = 0.7) {
        self.decay = decay
        peakBits = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
        peakBits.initialize(to: 0)
    }

    deinit {
        peakBits.deallocate()
    }

    /// Records the absolute peak of one converted chunk. Bits of a finite,
    /// non-negative `Float` sort like the float itself, so a plain unsigned
    /// compare-and-swap keeps the maximum.
    public nonisolated func record(_ samples: UnsafeBufferPointer<Float>) {
        var peak: Float = 0
        for value in samples {
            let magnitude = abs(value)
            if magnitude.isFinite && magnitude > peak {
                peak = magnitude
            }
        }
        guard peak > 0 else { return }

        let desired = Int32(bitPattern: peak.bitPattern)
        var current = OSAtomicAdd32Barrier(0, peakBits)
        while desired > current {
            if OSAtomicCompareAndSwap32Barrier(current, desired, peakBits) {
                return
            }
            current = OSAtomicAdd32Barrier(0, peakBits)
        }
    }

    /// Drops any pending peak, for example when the panel is hidden.
    public nonisolated func reset() {
        _ = exchange(0)
    }

    /// Returns the peak since the previous read, with a visual decay floor so
    /// the bars fall smoothly instead of snapping to zero.
    @MainActor
    public func snapshot() -> Float {
        let bits = exchange(0)
        let peak = bits == 0 ? 0 : Float(bitPattern: UInt32(bitPattern: bits))
        let displayed = max(peak, lastDisplayed * decay)
        lastDisplayed = displayed
        return displayed
    }

    private nonisolated func exchange(_ value: Int32) -> Int32 {
        var current = OSAtomicAdd32Barrier(0, peakBits)
        while !OSAtomicCompareAndSwap32Barrier(current, value, peakBits) {
            current = OSAtomicAdd32Barrier(0, peakBits)
        }
        return current
    }
}
