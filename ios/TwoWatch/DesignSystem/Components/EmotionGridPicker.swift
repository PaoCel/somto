import SwiftUI
import UIKit

/// Griglia di selezione emozioni post-visione ("Che impressione hai avuto?").
/// Riusabile dal composer voto e dal prompt post-visto. Selezione max 3: al
/// cap, il tap su una chip non selezionata è un no-op con haptic leggero
/// (feedback "non puoi aggiungerne altre" senza bloccare l'interazione).
struct EmotionGridPicker: View {
    @Binding var selection: Set<TitleEmotion>

    private let maxSelection = 3
    private let columns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10)
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            ForEach(TitleEmotion.allCases) { emotion in
                emotionChip(emotion)
            }
        }
    }

    private func emotionChip(_ emotion: TitleEmotion) -> some View {
        let isSelected = selection.contains(emotion)
        let isAtCap = !isSelected && selection.count >= maxSelection

        return Button {
            toggle(emotion, isSelected: isSelected, isAtCap: isAtCap)
        } label: {
            VStack(spacing: 4) {
                Text(emotion.emoji)
                    .somtoScaledFont(size: 26, relativeTo: .title)
                Text(emotion.label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.vertical, 10)
            .padding(.horizontal, 6)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(isSelected ? TwoWatchTheme.brandPrimary.opacity(0.16) : TwoWatchTheme.panel.opacity(0.7))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(isSelected ? TwoWatchTheme.brandPrimary : TwoWatchTheme.border, lineWidth: isSelected ? 1.5 : 1)
            )
            .opacity(isAtCap ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(emotion.label) \(emotion.emoji)")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private func toggle(_ emotion: TitleEmotion, isSelected: Bool, isAtCap: Bool) {
        let generator = UIImpactFeedbackGenerator(style: .soft)
        if isSelected {
            selection.remove(emotion)
            generator.impactOccurred(intensity: 0.6)
        } else if !isAtCap {
            selection.insert(emotion)
            generator.impactOccurred(intensity: 0.6)
        } else {
            generator.impactOccurred(intensity: 0.3)
        }
    }
}

#if DEBUG
#Preview("Emotion Grid Picker") {
    struct PreviewHost: View {
        @State private var selection: Set<TitleEmotion> = [.touched, .thrilled]

        var body: some View {
            EmotionGridPicker(selection: $selection)
                .padding(20)
                .background(TwoWatchTheme.background)
        }
    }
    return PreviewHost()
}
#endif
