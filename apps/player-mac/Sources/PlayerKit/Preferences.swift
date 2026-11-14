import Foundation

public enum AudioPreference {
    public static let key = "audioEnabled"
    public static let defaultValue = true

    public static func load(defaults: UserDefaults = .standard) -> Bool {
        guard defaults.object(forKey: key) != nil else { return defaultValue }
        return defaults.bool(forKey: key)
    }
}

public enum BrightnessPreference {
    public static let key = "brightness"
    public static let defaultValue = 100
    public static let minimum = 10
    public static let maximum = 100
    public static let step = 5

    public static func clamp(_ value: Int) -> Int {
        min(maximum, max(minimum, value))
    }

    public static func snap(_ value: Int) -> Int {
        let clamped = clamp(value)
        let steps = Int((Double(clamped - minimum) / Double(step)).rounded())
        return clamp(minimum + steps * step)
    }

    public static func load(defaults: UserDefaults = .standard) -> Int {
        guard defaults.object(forKey: key) != nil else { return defaultValue }
        return clamp(defaults.integer(forKey: key))
    }
}


public enum KeyboardPreference {
    public static let key = "preferredKeyboard"

    public static func load(defaults: UserDefaults = .standard) -> String? {
        guard let value = defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    public static func save(_ name: String?, defaults: UserDefaults = .standard) {
        if let name, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            defaults.set(name, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
