import SwiftUI

enum TwoWatchTheme {
    static let background = Color(hex: "#0A0A0A")
    static let backgroundSecondary = Color(hex: "#15151C")
    static let panel = Color.white.opacity(0.06)
    static let panelStrong = Color.white.opacity(0.1)
    static let border = Color.white.opacity(0.09)
    static let textPrimary = Color(hex: "#F5F5F5")
    static let textSecondary = Color(hex: "#A8A8A8")
    static let textMuted = Color.white.opacity(0.48)
    static let brandPrimary = Color(hex: "#E91E63")
    static let brandSecondary = Color(hex: "#9C27B0")
    static let brandWarm = Color(hex: "#F77737")
    static let accent = Color(hex: "#00D9FF")
    static let success = Color(hex: "#00E676")
    static let warning = Color(hex: "#FFB300")

    static let screenGradient = LinearGradient(
        colors: [
            Color(hex: "#191A30"),
            Color(hex: "#0A0A0A"),
            Color(hex: "#070707")
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let brandGradient = LinearGradient(
        colors: [brandWarm, brandPrimary, brandSecondary],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )

    static let tabMaterial = Material.ultraThin
}

