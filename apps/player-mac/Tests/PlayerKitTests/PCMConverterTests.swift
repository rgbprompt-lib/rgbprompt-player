import AudioToolbox
import XCTest
@testable import PlayerKit

final class PCMConverterTests: XCTestCase {
    private let floatFlags = AudioFormatFlags(kAudioFormatFlagIsFloat)
        | AudioFormatFlags(kAudioFormatFlagIsPacked)
    private let intFlags = AudioFormatFlags(kAudioFormatFlagIsSignedInteger)
        | AudioFormatFlags(kAudioFormatFlagIsPacked)

    func testFloat32InterleavedStereo() {
        let input: [Float] = [0.25, -0.5, 1.0, -1.0]
        let output = convert(input, bits: 32, channels: 2, flags: floatFlags, frames: 2)
        XCTAssertEqual(output?.frames, 2)
        XCTAssertEqual(output?.channels, 2)
        XCTAssertEqual(output?.samples, input)
    }

    func testFloat32NonInterleavedStereo() {
        let left: [Float] = [0.1, 0.2]
        let right: [Float] = [0.3, 0.4]
        let output = convertNonInterleaved(
            [left, right],
            bits: 32,
            channels: 2,
            flags: floatFlags | AudioFormatFlags(kAudioFormatFlagIsNonInterleaved)
        )
        XCTAssertEqual(output?.samples, [0.1, 0.3, 0.2, 0.4])
    }

    func testInt16Scaling() throws {
        let input: [Int16] = [32767, -32768, 16384, 0]
        let output = try XCTUnwrap(
            convert(input, bits: 16, channels: 2, flags: intFlags, frames: 2)
        )
        XCTAssertEqual(output.samples[0], 32767.0 / 32768.0, accuracy: 0.0001)
        XCTAssertEqual(output.samples[1], -1.0, accuracy: 0.0001)
        XCTAssertEqual(output.samples[2], 0.5, accuracy: 0.0001)
        XCTAssertEqual(output.samples[3], 0.0, accuracy: 0.0001)
    }

    func testInt32Scaling() throws {
        let input: [Int32] = [2_147_483_647, Int32.min, 1_073_741_824, 0]
        let output = try XCTUnwrap(
            convert(input, bits: 32, channels: 2, flags: intFlags, frames: 2)
        )
        XCTAssertEqual(output.samples[0], 1.0, accuracy: 0.0001)
        XCTAssertEqual(output.samples[1], -1.0, accuracy: 0.0001)
        XCTAssertEqual(output.samples[2], 0.5, accuracy: 0.0001)
        XCTAssertEqual(output.samples[3], 0.0, accuracy: 0.0001)
    }

    func testFloat64IsNarrowed() {
        let input: [Double] = [0.25, -0.5]
        let output = convert(input, bits: 64, channels: 1, flags: floatFlags, frames: 2)
        XCTAssertEqual(output?.samples, [0.25, -0.5])
    }

    func testNonFiniteValuesBecomeZero() {
        let input: [Float] = [.nan, .infinity, -.infinity, 0.5]
        let output = convert(input, bits: 32, channels: 1, flags: floatFlags, frames: 4)
        XCTAssertEqual(output?.samples, [0, 0, 0, 0.5])
    }

    func testMonoPassThrough() {
        let input: [Float] = [0.1, 0.2, 0.3]
        let output = convert(input, bits: 32, channels: 1, flags: floatFlags, frames: 3)
        XCTAssertEqual(output?.channels, 1)
        XCTAssertEqual(output?.samples, input)
    }

    func testUnsupportedInputsReturnNil() {
        XCTAssertNil(
            convert(
                [Float](repeating: 0, count: 9),
                bits: 32,
                channels: 9,
                flags: floatFlags,
                frames: 1
            )
        )
        XCTAssertNil(
            convert(
                [UInt16](repeating: 0, count: 2),
                bits: 16,
                channels: 1,
                flags: AudioFormatFlags(kAudioFormatFlagIsPacked),
                frames: 2
            ),
            "unsigned integer PCM"
        )
        XCTAssertNil(
            convert(
                [Float](repeating: 0, count: 2),
                bits: 32,
                channels: 1,
                flags: floatFlags,
                frames: 2,
                formatID: kAudioFormatMPEG4AAC
            ),
            "non-PCM"
        )
        XCTAssertNil(
            convert(
                [Float](repeating: 0, count: 2),
                bits: 32,
                channels: 1,
                flags: floatFlags,
                frames: 0
            )
        )
        XCTAssertNil(
            convert(
                [Float](repeating: 0, count: 8),
                bits: 32,
                channels: 2,
                flags: floatFlags,
                frames: 4,
                capacity: 4
            ),
            "destination too small"
        )
    }

    // MARK: - Helpers

    private struct Output {
        let frames: Int
        let channels: Int
        let samples: [Float]
    }

    private func convert<T>(
        _ samples: [T],
        bits: UInt32,
        channels: UInt32,
        flags: AudioFormatFlags,
        frames: Int,
        formatID: AudioFormatID = kAudioFormatLinearPCM,
        capacity: Int? = nil
    ) -> Output? {
        let format = makeFormat(
            formatID: formatID,
            bits: bits,
            channels: channels,
            flags: flags
        )
        let abl = AudioBufferList.allocate(maximumBuffers: 1)
        defer { free(abl.unsafeMutablePointer) }

        return samples.withUnsafeBytes { raw in
            abl[0] = AudioBuffer(
                mNumberChannels: channels,
                mDataByteSize: UInt32(raw.count),
                mData: UnsafeMutableRawPointer(mutating: raw.baseAddress)
            )
            var output = [Float](
                repeating: 0,
                count: max(1, capacity ?? frames * Int(channels))
            )
            let result = output.withUnsafeMutableBufferPointer { destination in
                PCMConverter.convert(
                    format: format,
                    buffers: abl,
                    frames: frames,
                    into: destination
                )
            }
            guard let result else { return nil }
            return Output(frames: result.frames, channels: result.channels, samples: output)
        }
    }

    private func convertNonInterleaved<T>(
        _ channels: [[T]],
        bits: UInt32,
        channels channelCount: UInt32,
        flags: AudioFormatFlags
    ) -> Output? {
        let frames = channels.map(\.count).min() ?? 0
        let format = makeFormat(
            formatID: kAudioFormatLinearPCM,
            bits: bits,
            channels: channelCount,
            flags: flags
        )
        let abl = AudioBufferList.allocate(maximumBuffers: channels.count)
        var allocations: [UnsafeMutableRawPointer] = []
        defer {
            for pointer in allocations {
                pointer.deallocate()
            }
            free(abl.unsafeMutablePointer)
        }

        for (index, channel) in channels.enumerated() {
            let byteCount = channel.count * MemoryLayout<T>.stride
            let raw = UnsafeMutableRawPointer.allocate(
                byteCount: byteCount,
                alignment: MemoryLayout<T>.alignment
            )
            channel.withUnsafeBytes { source in
                raw.copyMemory(from: source.baseAddress!, byteCount: byteCount)
            }
            allocations.append(raw)
            abl[index] = AudioBuffer(
                mNumberChannels: 1,
                mDataByteSize: UInt32(byteCount),
                mData: raw
            )
        }

        var output = [Float](
            repeating: 0,
            count: max(1, frames * Int(channelCount))
        )
        let result = output.withUnsafeMutableBufferPointer { destination in
            PCMConverter.convert(
                format: format,
                buffers: abl,
                frames: frames,
                into: destination
            )
        }
        guard let result else { return nil }
        return Output(frames: result.frames, channels: result.channels, samples: output)
    }

    private func makeFormat(
        formatID: AudioFormatID,
        bits: UInt32,
        channels: UInt32,
        flags: AudioFormatFlags
    ) -> AudioStreamBasicDescription {
        let bytes = bits / 8
        let nonInterleaved =
            flags & AudioFormatFlags(kAudioFormatFlagIsNonInterleaved) != 0
        let stride = bytes * (nonInterleaved ? 1 : channels)
        return AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: formatID,
            mFormatFlags: flags,
            mBytesPerPacket: stride,
            mFramesPerPacket: 1,
            mBytesPerFrame: stride,
            mChannelsPerFrame: channels,
            mBitsPerChannel: bits,
            mReserved: 0
        )
    }
}
