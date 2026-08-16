import SwiftUI

// Contorno del feed: skeleton di caricamento, badge "aggiornamento
// ufficiale", shimmer, banner d'errore. Estratti da CommunityView.swift.

struct HomeFeedSkeleton: View {
    var body: some View {
        VStack(spacing: 18) {
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 12) {
                        Circle()
                            .fill(TwoWatchTheme.panelStrong)
                            .frame(width: 38, height: 38)
                        VStack(alignment: .leading, spacing: 6) {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(TwoWatchTheme.panelStrong)
                                .frame(width: 120, height: 12)
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(TwoWatchTheme.panelStrong)
                                .frame(width: 170, height: 10)
                        }
                        Spacer()
                    }

                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(TwoWatchTheme.panelStrong)
                        .frame(height: 14)

                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.black.opacity(0.08))
                        .frame(height: 420)

                    HStack(spacing: 16) {
                        ForEach(0..<3, id: \.self) { _ in
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(TwoWatchTheme.panelStrong)
                                .frame(width: 44, height: 12)
                        }
                    }
                }
                .padding(12)
                .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .stroke(TwoWatchTheme.border, lineWidth: 1)
                )
                .modifier(ShimmerModifier())
            }
        }
    }
}

struct OfficialUpdateBadge: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "checkmark.seal.fill")
                .font(.caption2.weight(.bold))
            Text("Ufficiale")
                .font(.caption2.weight(.bold))
        }
        .foregroundStyle(TwoWatchTheme.brandPrimary)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(TwoWatchTheme.brandPrimary.opacity(0.10), in: Capsule())
        .overlay(Capsule().stroke(TwoWatchTheme.brandPrimary.opacity(0.22), lineWidth: 1))
        .accessibilityLabel("Aggiornamento ufficiale Somto")
    }
}

struct ShimmerModifier: ViewModifier {
    @State private var phase: CGFloat = -0.8

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { geometry in
                    LinearGradient(
                        colors: [
                            Color.white.opacity(0),
                            Color.white.opacity(0.32),
                            Color.white.opacity(0)
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .rotationEffect(.degrees(20))
                    .offset(x: geometry.size.width * phase)
                }
                .mask(content)
            }
            .onAppear {
                withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                    phase = 0.9
                }
            }
    }
}

extension PostVisibility {
    var symbolName: String {
        switch self {
        case .public:
            return "globe"
        case .friends:
            return "person.2"
        case .private:
            return "lock"
        }
    }
}

// MARK: - HomeErrorBanner

struct HomeErrorBanner: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.warning)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text("Caricamento incompleto")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text(message)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(3)
            }

            Spacer(minLength: 8)

            Button(action: onRetry) {
                Text("Riprova")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 32)
                    .background(TwoWatchTheme.brandPrimary, in: Capsule())
            }
            .accessibilityLabel("Riprova caricamento feed")
        }
        .padding(12)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.warning.opacity(0.35), lineWidth: 1)
        )
    }
}
