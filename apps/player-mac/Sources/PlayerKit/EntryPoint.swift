import Foundation

/// How the shell was asked to play something (PLY-04). Pure routing so the same
/// rules apply to Finder, URL schemes and launch arguments.
public enum EntryPoint: Equatable, Sendable {
    case playerURL(URL)
    case lepFile(URL)
    case ignored

    /// Whether opening this entry should reveal the panel.
    /// Only the explicit `rgbprompt://open` host may show it; play/push and
    /// `.lep` opens keep the panel's current visibility (hidden stays hidden).
    public var revealsPanel: Bool {
        switch self {
        case .playerURL(let url):
            return url.host?.lowercased() == "open"
        case .lepFile, .ignored:
            return false
        }
    }

    public static func classify(_ url: URL) -> EntryPoint {
        if url.scheme?.lowercased() == "rgbprompt" {
            return .playerURL(url)
        }
        if url.isFileURL && url.pathExtension.lowercased() == "lep" {
            return .lepFile(url)
        }
        return .ignored
    }

    /// A test/debug hook: the first `rgbprompt://…` or `*.lep` argument wins.
    public static func fromLaunchArguments(_ arguments: [String]) -> EntryPoint? {
        for argument in arguments.dropFirst() {
            if let url = URL(string: argument), url.scheme?.lowercased() == "rgbprompt" {
                return .playerURL(url)
            }
            if argument.lowercased().hasSuffix(".lep") {
                return .lepFile(URL(fileURLWithPath: argument).standardizedFileURL)
            }
        }
        return nil
    }
}
