import SwiftUI

struct PosterImageView: View {
    let url: URL?
    var width: CGFloat = 112
    var height: CGFloat = 168
    var cornerRadius: CGFloat = 20

    var body: some View {
        Group {
            if let url {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .scaledToFill()
                    case .failure:
                        placeholder
                    case .empty:
                        ZStack {
                            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                                .fill(TwoWatchTheme.panelStrong)
                            ProgressView()
                                .tint(TwoWatchTheme.textSecondary)
                        }
                    @unknown default:
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.28), radius: 16, y: 8)
    }

    private var placeholder: some View {
        ZStack {
            TwoWatchTheme.brandGradient
            Image(systemName: "film.stack.fill")
                .somtoScaledFont(size: 28, weight: .semibold, relativeTo: .title)
                .foregroundStyle(.white.opacity(0.82))
        }
    }
}
