import SwiftUI

/// Sub-brand lockup that pairs the Somto wordmark with a "QUIZ" badge.
///
/// Visually communicates "this is Somto Quiz, not generic Somto" without
/// touching the `SomtoWordmark` asset itself. The QUIZ badge uses the brand
/// gradient on a capsule, with the same rounded design family of the wordmark
/// so the two read as one lockup.
struct SomtoQuizLockup: View {
    enum Size {
        case small
        case medium
        case large

        var wordmarkWidth: CGFloat {
            switch self {
            case .small: return 96
            case .medium: return 128
            case .large: return 168
            }
        }

        var quizFont: Font {
            switch self {
            case .small: return .system(size: 14, weight: .black, design: .rounded)
            case .medium: return .system(size: 18, weight: .black, design: .rounded)
            case .large: return .system(size: 24, weight: .black, design: .rounded)
            }
        }

        var quizTracking: CGFloat {
            switch self {
            case .small: return 3
            case .medium: return 4
            case .large: return 6
            }
        }

        var horizontalPadding: CGFloat {
            switch self {
            case .small: return 10
            case .medium: return 12
            case .large: return 16
            }
        }

        var verticalPadding: CGFloat {
            switch self {
            case .small: return 4
            case .medium: return 5
            case .large: return 7
            }
        }

        var spacing: CGFloat {
            switch self {
            case .small: return 8
            case .medium: return 10
            case .large: return 12
            }
        }
    }

    var size: Size = .medium
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        VStack(alignment: alignment, spacing: size.spacing) {
            BrandWordmarkView(width: size.wordmarkWidth)
                .accessibilityHidden(true)

            Text("QUIZ")
                .font(size.quizFont)
                .tracking(size.quizTracking)
                .foregroundStyle(.white)
                .padding(.horizontal, size.horizontalPadding)
                .padding(.vertical, size.verticalPadding)
                .background(
                    Capsule(style: .continuous)
                        .fill(TwoWatchTheme.brandGradient)
                )
                .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.32), radius: 12, y: 6)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Somto Quiz")
    }
}

#if DEBUG
#Preview("Somto Quiz Lockup", traits: .fixedLayout(width: 393, height: 320)) {
    ZStack {
        TwoWatchTheme.background.ignoresSafeArea()
        VStack(spacing: 32) {
            SomtoQuizLockup(size: .small)
            SomtoQuizLockup(size: .medium)
            SomtoQuizLockup(size: .large)
        }
    }
}
#endif
