import SwiftUI

struct TwoWatchBackground: View {
    var body: some View {
        ZStack {
            TwoWatchTheme.screenGradient
                .ignoresSafeArea()

            Circle()
                .fill(TwoWatchTheme.brandPrimary.opacity(0.18))
                .blur(radius: 120)
                .frame(width: 280, height: 280)
                .offset(x: 120, y: -260)

            Circle()
                .fill(TwoWatchTheme.accent.opacity(0.1))
                .blur(radius: 120)
                .frame(width: 260, height: 260)
                .offset(x: -130, y: -180)

            Circle()
                .fill(TwoWatchTheme.brandSecondary.opacity(0.14))
                .blur(radius: 130)
                .frame(width: 320, height: 320)
                .offset(x: -100, y: 320)
        }
    }
}

