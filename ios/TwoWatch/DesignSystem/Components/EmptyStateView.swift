import SwiftUI

struct EmptyStateView: View {
    let title: LocalizedStringKey
    let message: LocalizedStringKey
    let systemImage: String
    var actionTitle: LocalizedStringKey?
    var action: (() -> Void)?

    var body: some View {
        GlassCard {
            VStack(spacing: 14) {
                Image(systemName: systemImage)
                    .somtoScaledFont(size: 28, weight: .semibold, relativeTo: .title)
                    .foregroundStyle(TwoWatchTheme.accent)

                Text(title)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .multilineTextAlignment(.center)

                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .multilineTextAlignment(.center)

                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(PrimaryButtonStyle())
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }
}

