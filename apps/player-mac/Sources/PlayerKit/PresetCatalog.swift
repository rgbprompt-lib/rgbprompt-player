import Foundation

public struct PlayerPreset: Identifiable, Equatable, Sendable {
    public let id: String
    public let fileName: String
    public let nameZh: String
    public let nameEn: String
    public let hasAudio: Bool
    public let order: Int
    public var fileURL: URL?
    /// Reacts to key presses (from the engine-rendered thumbnail data).
    public var needsKeys: Bool = false
    /// One engine-rendered frame, 104 x RGB in KeyLayout order. Empty when the
    /// thumbnail file is missing.
    public var thumbnail: [UInt8] = []

    public init(
        id: String,
        fileName: String,
        nameZh: String,
        nameEn: String,
        hasAudio: Bool,
        order: Int,
        fileURL: URL?,
        needsKeys: Bool = false,
        thumbnail: [UInt8] = []
    ) {
        self.id = id
        self.fileName = fileName
        self.nameZh = nameZh
        self.nameEn = nameEn
        self.hasAudio = hasAudio
        self.order = order
        self.fileURL = fileURL
        self.needsKeys = needsKeys
        self.thumbnail = thumbnail
    }
}

public enum PresetCatalog {
    public static func load(bundle: Bundle = .main) -> [PlayerPreset] {
        guard let url = bundle.url(forResource: "manifest", withExtension: "json", subdirectory: "Presets")
            ?? bundle.url(forResource: "manifest", withExtension: "json")
        else {
            return []
        }
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["presets"] as? [[String: Any]]
        else {
            return []
        }
        let presetsDir = url.deletingLastPathComponent()
        let thumbnails = loadThumbnails(directory: presetsDir)
        return list.compactMap { item -> PlayerPreset? in
            guard let id = item["id"] as? String,
                  let file = item["file"] as? String,
                  let nameZh = item["name_zh"] as? String,
                  let nameEn = item["name_en"] as? String
            else { return nil }
            let hasAudio = item["hasAudio"] as? Bool ?? false
            let order = item["order"] as? Int ?? 0
            let fileURL = presetsDir.appendingPathComponent(file)
            let resolved = FileManager.default.fileExists(atPath: fileURL.path) ? fileURL : nil
            return PlayerPreset(
                id: id,
                fileName: file,
                nameZh: nameZh,
                nameEn: nameEn,
                hasAudio: hasAudio,
                order: order,
                fileURL: resolved,
                needsKeys: thumbnails[id]?.needsKeys ?? false,
                thumbnail: thumbnails[id]?.rgb ?? []
            )
        }
        .sorted { $0.order < $1.order }
    }

    /// `thumbnails.json` is written by tools/player/gen-preset-thumbs.mjs.
    static func loadThumbnails(directory: URL) -> [String: (needsKeys: Bool, rgb: [UInt8])] {
        let url = directory.appendingPathComponent("thumbnails.json")
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let presets = root["presets"] as? [String: [String: Any]]
        else {
            return [:]
        }
        var result: [String: (needsKeys: Bool, rgb: [UInt8])] = [:]
        for (id, item) in presets {
            let values = (item["rgb"] as? [NSNumber])?.map { UInt8(clamping: $0.intValue) } ?? []
            result[id] = (item["needsKeys"] as? Bool ?? false, values)
        }
        return result
    }

    public static func displayName(_ preset: PlayerPreset, language: String) -> String {
        language.hasPrefix("zh") ? preset.nameZh : preset.nameEn
    }
}
