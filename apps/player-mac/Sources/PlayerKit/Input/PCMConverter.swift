import CoreAudio

/// Converts a Core Audio buffer list into interleaved `Float` PCM for
/// `rgbp_push_audio_pcm` (PLAYER §5.1). Pure and allocation-free: the audio
/// thread calls it with its own scratch buffer.
public enum PCMConverter {
    public struct Output: Equatable, Sendable {
        public let frames: Int
        public let channels: Int

        public init(frames: Int, channels: Int) {
            self.frames = frames
            self.channels = channels
        }
    }

    private enum Kind {
        case float32
        case float64
        case int16
        case int32

        var bytes: Int {
            switch self {
            case .float32: return 4
            case .float64: return 8
            case .int16: return 2
            case .int32: return 4
            }
        }
    }

    private static let maximumChannels = 8

    public static func convert(
        format: AudioStreamBasicDescription,
        buffers: UnsafeMutableAudioBufferListPointer,
        frameOffset: Int = 0,
        frames: Int,
        into destination: UnsafeMutableBufferPointer<Float>
    ) -> Output? {
        guard frames > 0, frameOffset >= 0, frameOffset <= Int.max - frames else {
            return nil
        }
        guard format.mFormatID == kAudioFormatLinearPCM else { return nil }
        guard format.mFormatFlags & kAudioFormatFlagIsBigEndian == 0 else { return nil }

        let channels = Int(format.mChannelsPerFrame)
        guard channels >= 1, channels <= maximumChannels else { return nil }
        guard frames <= destination.count / channels else { return nil }

        let isFloat = format.mFormatFlags & kAudioFormatFlagIsFloat != 0
        let isSigned = format.mFormatFlags & kAudioFormatFlagIsSignedInteger != 0
        let isNonInterleaved = format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        let bits = Int(format.mBitsPerChannel)

        let kind: Kind
        if isFloat {
            switch bits {
            case 32: kind = .float32
            case 64: kind = .float64
            default: return nil
            }
        } else if isSigned {
            switch bits {
            case 16: kind = .int16
            case 32: kind = .int32
            default: return nil
            }
        } else {
            return nil
        }

        let lastFrame = frameOffset + frames
        guard lastFrame <= Int.max / (channels * kind.bytes) else { return nil }

        if isNonInterleaved {
            guard buffers.count >= channels else { return nil }
            for channel in 0..<channels {
                let buffer = buffers[channel]
                guard let data = buffer.mData,
                      Int(buffer.mDataByteSize) >= lastFrame * kind.bytes else {
                    return nil
                }
                for frame in 0..<frames {
                    destination[frame * channels + channel] = sample(
                        data,
                        frameOffset + frame,
                        kind
                    )
                }
            }
        } else {
            guard buffers.count >= 1 else { return nil }
            let buffer = buffers[0]
            guard let data = buffer.mData,
                  Int(buffer.mDataByteSize) >= lastFrame * channels * kind.bytes else {
                return nil
            }
            for frame in 0..<frames {
                let sourceFrame = (frameOffset + frame) * channels
                let outputFrame = frame * channels
                for channel in 0..<channels {
                    destination[outputFrame + channel] = sample(
                        data,
                        sourceFrame + channel,
                        kind
                    )
                }
            }
        }

        return Output(frames: frames, channels: channels)
    }

    @inline(__always)
    private static func sample(_ data: UnsafeRawPointer, _ index: Int, _ kind: Kind) -> Float {
        switch kind {
        case .float32:
            return finite(data.load(fromByteOffset: index * 4, as: Float.self))
        case .float64:
            return finite(Float(data.load(fromByteOffset: index * 8, as: Double.self)))
        case .int16:
            return Float(data.load(fromByteOffset: index * 2, as: Int16.self)) / 32_768
        case .int32:
            return Float(data.load(fromByteOffset: index * 4, as: Int32.self)) / 2_147_483_648
        }
    }

    @inline(__always)
    private static func finite(_ value: Float) -> Float {
        value.isFinite ? value : 0
    }
}
