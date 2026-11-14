import Foundation

/// Logging helpers. URLs may contain a one-time play token, so only the scheme,
/// host and the first six token characters are written to the log.
public enum Redact {
    public static func playerURL(_ raw: String) -> String {
        guard let components = URLComponents(string: raw), components.scheme != nil else {
            return "<invalid-url>"
        }
        let scheme = components.scheme ?? ""
        let host = components.host ?? ""
        let token = components.queryItems?.first(where: { $0.name == "t" })?.value ?? ""
        let prefix = token.count <= 6 ? token : String(token.prefix(6))
        return "\(scheme)://\(host)?t=\(prefix)…"
    }
}
