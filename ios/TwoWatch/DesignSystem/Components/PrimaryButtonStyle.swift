import SwiftUI

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 15)
            .background(TwoWatchTheme.brandGradient)
            .clipShape(Capsule(style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .shadow(color: TwoWatchTheme.brandPrimary.opacity(0.32), radius: 18, y: 10)
    }
}

