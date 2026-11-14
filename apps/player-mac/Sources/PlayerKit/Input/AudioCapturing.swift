import AudioToolbox
import CoreAudio
import Foundation
import os

public enum AudioStartResult: Equatable, Sendable {
    case started
    case failed(OSStatus)
}

public typealias AudioPCMHandler =
    (UnsafeBufferPointer<Float>, _ frames: Int, _ channels: UInt16, _ sampleRate: Double) -> Void

public protocol AudioCapturing: AnyObject {
    func start(onPCM: @escaping AudioPCMHandler) -> AudioStartResult
    func stop()
    func isAnyOtherProcessPlayingAudio() -> Bool
}

/// System-audio capture through a Core Audio process tap plus a private
/// aggregate device (macOS 14.2+, PLAYER §5.1). The tap is stereo, unmuted and
/// excludes this process. The IO block never allocates or locks: it converts
/// into a scratch buffer allocated in `start`.
public final class ProcessTapAudioCapture: AudioCapturing, @unchecked Sendable {
    private static let logger = Logger(subsystem: "com.rgbprompt.player", category: "input")
    fileprivate static let chunkFrames = 8192
    private static let maximumChannels = 8
    private static let scratchCapacity = chunkFrames * maximumChannels

    nonisolated(unsafe) private var tapID: AudioObjectID = kAudioObjectUnknown
    nonisolated(unsafe) private var aggregateID: AudioObjectID = kAudioObjectUnknown
    nonisolated(unsafe) private var ioProcID: AudioDeviceIOProcID?
    nonisolated(unsafe) private var queue: DispatchQueue?
    nonisolated(unsafe) private var context: IOContext?
    nonisolated(unsafe) private var handler: AudioPCMHandler?
    nonisolated(unsafe) private var listenerBlock: AudioObjectPropertyListenerBlock?

    public init() {}

    deinit {
        teardown()
    }

    public func start(onPCM: @escaping AudioPCMHandler) -> AudioStartResult {
        teardown()
        handler = onPCM
        let result = build()
        switch result {
        case .started:
            Self.logger.info("audio_capture start")
        case .failed(let status):
            teardown()
            Self.logger.error("audio_capture failed status=\(status)")
        }
        return result
    }

    public func stop() {
        let hadResources = tapID != kAudioObjectUnknown
            || aggregateID != kAudioObjectUnknown
            || ioProcID != nil
            || listenerBlock != nil
        teardown()
        if hadResources {
            Self.logger.info("audio_capture stop")
        }
    }

    public func isAnyOtherProcessPlayingAudio() -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size
        ) == noErr else {
            return false
        }

        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        guard count > 0 else { return false }

        var processes = [AudioObjectID](repeating: kAudioObjectUnknown, count: count)
        let status = processes.withUnsafeMutableBytes { buffer in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                0,
                nil,
                &size,
                buffer.baseAddress!
            )
        }
        guard status == noErr else { return false }

        let ownPID = UInt32(bitPattern: getpid())
        for process in processes {
            guard let pid = readUInt32(process, kAudioProcessPropertyPID),
                  pid != ownPID else {
                continue
            }
            if readUInt32(process, kAudioProcessPropertyIsRunningOutput) == 1 {
                return true
            }
        }
        return false
    }

    // MARK: - Setup

    private func build() -> AudioStartResult {
        guard let handler else { return .failed(kAudioHardwareBadObjectError) }
        guard let ownProcess = processObject(for: getpid()) else {
            return .failed(kAudioHardwareBadObjectError)
        }

        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [ownProcess])
        description.isPrivate = true
        description.muteBehavior = CATapMuteBehavior.unmuted
        description.name = "RGBPrompt Player"
        description.uuid = UUID()

        var tap: AudioObjectID = kAudioObjectUnknown
        var status = AudioHardwareCreateProcessTap(description, &tap)
        guard status == noErr else { return .failed(status) }
        tapID = tap

        guard let format = tapFormat(tap) else {
            return .failed(kAudioHardwareBadObjectError)
        }

        let aggregateUID = "com.rgbprompt.player.\(UUID().uuidString)"
        var aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "RGBPrompt Player",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        if let output = defaultOutputDevice(), let outputUID = deviceUID(output) {
            aggregateDescription[kAudioAggregateDeviceMainSubDeviceKey] = outputUID
            aggregateDescription[kAudioAggregateDeviceSubDeviceListKey] = [[
                kAudioSubDeviceUIDKey: outputUID,
            ]]
            aggregateDescription[kAudioAggregateDeviceClockDeviceKey] = outputUID
        }

        var aggregate: AudioObjectID = kAudioObjectUnknown
        status = AudioHardwareCreateAggregateDevice(
            aggregateDescription as CFDictionary,
            &aggregate
        )
        guard status == noErr else { return .failed(status) }
        aggregateID = aggregate

        let scratch = UnsafeMutableBufferPointer<Float>.allocate(
            capacity: Self.scratchCapacity
        )
        scratch.initialize(repeating: 0)
        let context = IOContext(format: format, scratch: scratch, handler: handler)
        self.context = context

        let queue = DispatchQueue(
            label: "com.rgbprompt.player.audio",
            qos: .userInteractive
        )
        self.queue = queue

        var ioProc: AudioDeviceIOProcID?
        status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregate, queue) {
            _, inputData, _, _, _ in
            context.consume(inputData)
        }
        guard status == noErr, let ioProc else { return .failed(status) }
        ioProcID = ioProc

        status = AudioDeviceStart(aggregate, ioProc)
        guard status == noErr else { return .failed(status) }

        installDefaultOutputListener()
        return .started
    }

    private func teardown() {
        removeDefaultOutputListener()

        if let ioProcID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, ioProcID)
            AudioDeviceDestroyIOProcID(aggregateID, ioProcID)
        }
        ioProcID = nil

        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }

        context = nil
        queue = nil
        handler = nil
    }

    private func rebuild() {
        guard let handler else { return }
        _ = start(onPCM: handler)
    }

    private func installDefaultOutputListener() {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            DispatchQueue.main.async { [weak self] in
                self?.rebuild()
            }
        }
        if AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            DispatchQueue.main,
            block
        ) == noErr {
            listenerBlock = block
        }
    }

    private func removeDefaultOutputListener() {
        guard let listenerBlock else { return }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            DispatchQueue.main,
            listenerBlock
        )
        self.listenerBlock = nil
    }

    // MARK: - Core Audio helpers

    private func processObject(for pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value = pid
        var process: AudioObjectID = kAudioObjectUnknown
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            UInt32(MemoryLayout<pid_t>.size),
            &value,
            &size,
            &process
        )
        guard status == noErr, process != kAudioObjectUnknown else { return nil }
        return process
    }

    private func tapFormat(_ tap: AudioObjectID) -> AudioStreamBasicDescription? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &format)
        return status == noErr ? format : nil
    }

    private func defaultOutputDevice() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device: AudioObjectID = kAudioObjectUnknown
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &device
        )
        guard status == noErr, device != kAudioObjectUnknown else { return nil }
        return device
    }

    private func deviceUID(_ device: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(device, &address, 0, nil, &size, pointer)
        }
        guard status == noErr, let uid else { return nil }
        let value = uid.takeRetainedValue() as String
        return value.isEmpty ? nil : value
    }

    private func readUInt32(
        _ object: AudioObjectID,
        _ selector: AudioObjectPropertySelector
    ) -> UInt32? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
        return status == noErr ? value : nil
    }
}

private final class IOContext: @unchecked Sendable {
    let format: AudioStreamBasicDescription
    let scratch: UnsafeMutableBufferPointer<Float>
    let handler: AudioPCMHandler

    init(
        format: AudioStreamBasicDescription,
        scratch: UnsafeMutableBufferPointer<Float>,
        handler: @escaping AudioPCMHandler
    ) {
        self.format = format
        self.scratch = scratch
        self.handler = handler
    }

    deinit {
        scratch.deallocate()
    }

    func consume(_ inputData: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(
            UnsafeMutablePointer(mutating: inputData)
        )
        guard let frames = frameCount(buffers), frames > 0 else { return }

        var offset = 0
        while offset < frames {
            let count = min(ProcessTapAudioCapture.chunkFrames, frames - offset)
            guard let output = PCMConverter.convert(
                format: format,
                buffers: buffers,
                frameOffset: offset,
                frames: count,
                into: scratch
            ) else {
                return
            }
            let sampleCount = output.frames * output.channels
            let samples = UnsafeBufferPointer(start: scratch.baseAddress, count: sampleCount)
            handler(samples, output.frames, UInt16(output.channels), format.mSampleRate)
            offset += count
        }
    }

    private func frameCount(_ buffers: UnsafeMutableAudioBufferListPointer) -> Int? {
        guard let first = buffers.first, first.mData != nil else { return nil }
        let bytesPerSample = max(1, Int(format.mBitsPerChannel) / 8)
        if format.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 {
            return Int(first.mDataByteSize) / bytesPerSample
        }
        let channels = max(1, Int(format.mChannelsPerFrame))
        return Int(first.mDataByteSize) / (bytesPerSample * channels)
    }
}
