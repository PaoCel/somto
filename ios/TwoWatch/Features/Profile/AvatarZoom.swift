import SwiftUI

// Zoom sull'avatar: overlay, modifier e la scorciatoia su View. Estratti da
// ProfileComponents.swift.

struct AvatarZoomOverlay: View {
    let url: URL?
    let initials: String
    let onClose: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.92)
                .ignoresSafeArea()
                .onTapGesture { onClose() }

            CachedAsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                default:
                    ZStack {
                        TwoWatchTheme.brandGradient
                        Text(initials)
                            .font(.system(size: 96, weight: .black, design: .rounded))
                            .foregroundStyle(.white)
                    }
                }
            }
            .frame(width: 300, height: 300)
            .clipShape(Circle())
            .overlay(Circle().stroke(Color.white.opacity(0.9), lineWidth: 3))
            .shadow(color: .black.opacity(0.5), radius: 30, y: 12)
            .onTapGesture { onClose() }

            VStack {
                HStack {
                    Spacer()
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 40, height: 40)
                            .background(Color.white.opacity(0.16), in: Circle())
                    }
                    .padding(20)
                    .accessibilityLabel("Chiudi")
                }
                Spacer()
            }
        }
    }
}

struct AvatarZoomModifier: ViewModifier {
    let url: URL?
    let initials: String
    @State private var isZoomed = false

    func body(content: Content) -> some View {
        content
            .contentShape(Circle())
            .onTapGesture { isZoomed = true }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Tocca per ingrandire la foto profilo")
            .fullScreenCover(isPresented: $isZoomed) {
                AvatarZoomOverlay(url: url, initials: initials) { isZoomed = false }
                    .presentationBackground(.clear)
            }
    }
}

extension View {
    /// Rende un avatar toccabile per vederlo ingrandito dentro un cerchio.
    func avatarZoomable(url: URL?, initials: String) -> some View {
        modifier(AvatarZoomModifier(url: url, initials: initials))
    }
}
