import SwiftUI
import UIKit

// MARK: - Share Card View (1080x1920 — Instagram Stories 9:16)

struct WatchTimeShareCardView: View {
    let displayName: String
    let initials: String
    let days: Int
    let hours: Int
    let minutes: Int
    let watchedCount: Int
    let reviewCount: Int

    private let cardWidth: CGFloat = 1080
    private let cardHeight: CGFloat = 1920

    var body: some View {
        ZStack {
            background
            decorativeOrbs
            content
        }
        .frame(width: cardWidth, height: cardHeight)
        .clipped()
    }

    // MARK: - Background

    private var background: some View {
        LinearGradient(
            colors: [
                Color(hex: "#F77737"),
                Color(hex: "#E91E63"),
                Color(hex: "#9C27B0"),
                Color(hex: "#7B1FA2")
            ],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private var decorativeOrbs: some View {
        ZStack {
            Circle()
                .fill(Color.white.opacity(0.06))
                .frame(width: 600, height: 600)
                .offset(x: -260, y: -500)

            Circle()
                .fill(Color.white.opacity(0.05))
                .frame(width: 500, height: 500)
                .offset(x: 300, y: 200)

            Circle()
                .fill(Color.white.opacity(0.04))
                .frame(width: 400, height: 400)
                .offset(x: -200, y: 600)

            Circle()
                .fill(Color(hex: "#00D9FF").opacity(0.08))
                .frame(width: 350, height: 350)
                .offset(x: 250, y: -200)
        }
    }

    // MARK: - Content

    private var content: some View {
        VStack(spacing: 0) {
            Spacer()
                .frame(height: 280)

            avatarSection

            Spacer()
                .frame(height: 80)

            timeHeroSection

            Spacer()
                .frame(height: 60)

            statsRow

            Spacer()

            brandFooter

            Spacer()
                .frame(height: 120)
        }
        .padding(.horizontal, 80)
    }

    // MARK: - Avatar + Name

    private var avatarSection: some View {
        VStack(spacing: 32) {
            ZStack {
                Circle()
                    .fill(Color.white.opacity(0.15))
                    .frame(width: 200, height: 200)

                Text(initials)
                    .font(.system(size: 72, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
            }

            Text(displayName)
                .font(.system(size: 52, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }

    // MARK: - Time Hero

    private var timeHeroSection: some View {
        VStack(spacing: 24) {
            Text("TEMPO DI VISIONE")
                .font(.system(size: 28, weight: .heavy, design: .rounded))
                .foregroundStyle(.white.opacity(0.7))
                .tracking(6)

            HStack(alignment: .firstTextBaseline, spacing: 20) {
                shareTimeBlock(value: days, unit: "giorni")
                shareSeparator
                shareTimeBlock(value: hours, unit: "ore")
                shareSeparator
                shareTimeBlock(value: minutes, unit: "min")
            }
        }
        .padding(.vertical, 56)
        .padding(.horizontal, 48)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 40, style: .continuous)
                .fill(Color.white.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 40, style: .continuous)
                .stroke(Color.white.opacity(0.2), lineWidth: 2)
        )
    }

    private func shareTimeBlock(value: Int, unit: String) -> some View {
        VStack(spacing: 8) {
            Text(String(format: "%02d", max(0, value)))
                .font(.system(size: 80, weight: .black, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.5)

            Text(unit)
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.7))
        }
    }

    private var shareSeparator: some View {
        Text(":")
            .font(.system(size: 64, weight: .black, design: .rounded))
            .foregroundStyle(.white.opacity(0.4))
            .padding(.bottom, 36)
    }

    // MARK: - Stats

    private var statsRow: some View {
        HStack(spacing: 24) {
            statCapsule(icon: "film", text: "\(watchedCount) titoli visti")
            statCapsule(icon: "text.bubble", text: "\(reviewCount) review")
        }
    }

    private func statCapsule(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 24, weight: .semibold))
            Text(text)
                .font(.system(size: 26, weight: .bold, design: .rounded))
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 32)
        .padding(.vertical, 20)
        .background(
            Capsule()
                .fill(Color.white.opacity(0.15))
        )
        .overlay(
            Capsule()
                .stroke(Color.white.opacity(0.2), lineWidth: 1)
        )
    }

    // MARK: - Brand

    private var brandFooter: some View {
        VStack(spacing: 20) {
            Image("SomtoWordmark")
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .frame(width: 240)
                .foregroundStyle(.white.opacity(0.8))

            HStack(spacing: 12) {
                Image(systemName: "apple.logo")
                    .font(.system(size: 28))
                Text("Disponibile su App Store")
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
            }
            .foregroundStyle(.white.opacity(0.7))
            .padding(.horizontal, 32)
            .padding(.vertical, 16)
            .background(
                Capsule()
                    .fill(Color.white.opacity(0.1))
            )
            .overlay(
                Capsule()
                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
            )
        }
    }
}

// MARK: - Share Helper

enum WatchTimeShareHelper {
    @MainActor
    static func renderShareImage(
        user: AppUser,
        activitySummary: ProfileActivitySummary,
        reviewCount: Int
    ) -> UIImage? {
        let safeMinutes = max(0, activitySummary.totalWatchMinutes)
        let days = safeMinutes / 1_440
        let hours = (safeMinutes % 1_440) / 60
        let minutes = safeMinutes % 60

        let parts = user.displayName.split(whereSeparator: \.isWhitespace)
        let first = parts.first?.first.map(String.init) ?? "?"
        let last = parts.count > 1 ? parts.last?.first.map(String.init) ?? "" : ""
        let initials = (first + last).uppercased()

        let view = WatchTimeShareCardView(
            displayName: user.displayName,
            initials: initials,
            days: days,
            hours: hours,
            minutes: minutes,
            watchedCount: activitySummary.watchedTitlesCount,
            reviewCount: reviewCount
        )

        let renderer = ImageRenderer(content: view)
        renderer.scale = 1.0
        return renderer.uiImage
    }

    // Tocca UIApplication.shared e UIPasteboard.general, entrambi isolati
    // al main actor. Girava gia' da li' (la chiama un bottone), mancava la
    // dichiarazione.
    @MainActor
    static func shareToInstagramStories(image: UIImage) -> Bool {
        guard let url = URL(string: "instagram-stories://share"),
              UIApplication.shared.canOpenURL(url),
              let imageData = image.pngData()
        else { return false }

        let items: [String: Any] = [
            "com.instagram.sharedSticker.backgroundImage": imageData,
            "com.instagram.sharedSticker.contentURL": "https://somto.it"
        ]
        UIPasteboard.general.setItems([items], options: [.expirationDate: Date().addingTimeInterval(300)])
        UIApplication.shared.open(url)
        return true
    }
}

// MARK: - Share Sheet

struct ShareSheetView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
