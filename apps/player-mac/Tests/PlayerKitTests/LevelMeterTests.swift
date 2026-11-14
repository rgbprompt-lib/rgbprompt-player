import XCTest
@testable import PlayerKit

@MainActor
final class LevelMeterTests: XCTestCase {
    func testSilenceIsZero() {
        let meter = LevelMeter()
        let silence = [Float](repeating: 0, count: 128)
        silence.withUnsafeBufferPointer { meter.record($0) }
        XCTAssertEqual(meter.snapshot(), 0, accuracy: 0.0001)
    }

    func testFullScaleSineReachesTheTop() {
        let meter = LevelMeter()
        var samples = [Float](repeating: 0, count: 2_048)
        for index in samples.indices {
            samples[index] = sin(Float(index) * 0.1)
        }
        samples.withUnsafeBufferPointer { meter.record($0) }
        XCTAssertGreaterThan(meter.snapshot(), 0.9)
    }

    func testDecaysTowardsZero() {
        let meter = LevelMeter(decay: 0.5)
        let loud = [Float](repeating: 1, count: 64)
        loud.withUnsafeBufferPointer { meter.record($0) }

        var previous = meter.snapshot()
        XCTAssertGreaterThan(previous, 0.9)

        for _ in 0..<10 {
            let next = meter.snapshot()
            XCTAssertLessThanOrEqual(next, previous)
            previous = next
        }
        XCTAssertLessThan(previous, 0.05)
    }
}
