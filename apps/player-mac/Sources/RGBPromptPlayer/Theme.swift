import SwiftUI

/// The only palette used by the panel and the setup window. Values match the
/// Player App boards (3.5 menu-bar panel, 3.6 setup window).
enum Theme {
    static let background = Color(hex: 0x151922)
    static let windowBackground = Color(hex: 0x0E1118)
    static let inset = Color(hex: 0x0B0D12)
    static let border = Color(hex: 0x232835)
    static let control = Color(hex: 0x3A4150)
    static let stepIndex = Color(hex: 0x1E2330)
    static let primary = Color(hex: 0x2EE59D)
    static let primaryPressed = Color(hex: 0x1E8E62)
    static let text = Color(hex: 0xF4F6FA)
    static let secondary = Color(hex: 0x9AA3B2)
    static let tertiary = Color(hex: 0x7D8597)
    static let info = Color(hex: 0x6FA8FF)
    static let accent = info
    static let warning = Color(hex: 0xFFA43A)
    static let danger = Color(hex: 0xFF6B84)
    static let card = text.opacity(0.04)
    static let disabled = Color(hex: 0x3A4150)
    static let onPrimary = background
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// Type scale for the panel and windows. Matches the web stack: Space Grotesk
/// (bundled, see `ATSApplicationFontsPath`) for Latin text; Chinese has no
/// glyphs in it and falls back to the system face (PingFang).
enum Typography {
    static let headline = sans(15, .semibold)
    static let title = sans(13, .semibold)
    static let body = sans(12)
    static let bodyStrong = sans(12, .semibold)
    static let caption = sans(11)
    static let captionStrong = sans(11, .semibold)
    static let footnote = sans(10)
    static let footnoteStrong = sans(10, .semibold)

    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        Font.custom(postScriptName(for: weight), fixedSize: size)
    }

    private static func postScriptName(for weight: Font.Weight) -> String {
        if weight == .medium { return "SpaceGrotesk-Medium" }
        if weight == .semibold { return "SpaceGrotesk-SemiBold" }
        if weight == .bold || weight == .heavy || weight == .black { return "SpaceGrotesk-Bold" }
        return "SpaceGrotesk-Regular"
    }
}
