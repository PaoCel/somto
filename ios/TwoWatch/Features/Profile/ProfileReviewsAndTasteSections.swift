import SwiftUI

// Recensioni scritte e sezione gusti del profilo. Estratte da
// ProfileComponents.swift.

enum ProfileActivityItem: Identifiable {
    case review(ProfileReviewEntry)
    case emotion(TitleEmotionEntry)
    case post(AppPost)

    var id: String {
        switch self {
        case let .review(review):
            return "review_\(review.id)"
        case let .emotion(emotion):
            return "emotion_\(emotion.id)"
        case let .post(post):
            return "post_\(post.id)"
        }
    }

    var sortDate: Date {
        switch self {
        case let .review(review):
            return review.sortDate
        case let .emotion(emotion):
            return emotion.sortDate
        case let .post(post):
            return post.createdAt ?? post.updatedAt ?? .distantPast
        }
    }
}

struct ProfileReviewsSection: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let reviews: [ProfileReviewEntry]
    var emotions: [TitleEmotionEntry] = []
    var posts: [AppPost] = []
    var isLoading = false
    var embedsInCard = true

    @State private var visibleCount = 6

    private let batchSize = 6
    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#4B5563")
    private let cardBackground = Color(hex: "#FCFBF6")
    private let cardBorder = Color.black.opacity(0.08)

    private var timelineItems: [ProfileActivityItem] {
        var items: [ProfileActivityItem] = []
        items.append(contentsOf: reviews.map(ProfileActivityItem.review))
        items.append(contentsOf: emotions.map(ProfileActivityItem.emotion))
        items.append(contentsOf: posts.map(ProfileActivityItem.post))
        return items.sorted { $0.sortDate > $1.sortDate }
    }

    private var visibleItems: [ProfileActivityItem] {
        Array(timelineItems.prefix(visibleCount))
    }

    private var hasMoreItems: Bool {
        visibleItems.count < timelineItems.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Attività")
                        .font(.headline)
                        .foregroundStyle(textPrimary)
                    Text("Recensioni, emozioni e post pubblicati di recente.")
                        .font(.caption)
                        .foregroundStyle(textSecondary)
                }

                Spacer()

                Text("\(timelineItems.count)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(textSecondary)
            }

            if isLoading && timelineItems.isEmpty {
                GlassCard {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                        .tint(TwoWatchTheme.textPrimary)
                }
            } else if timelineItems.isEmpty {
                EmptyStateView(
                    title: "Nessuna attività ancora",
                    message: "Qui compariranno le recensioni, le emozioni e i post pubblici di questo utente.",
                    systemImage: "sparkles"
                )
            } else {
                VStack(spacing: 12) {
                    ForEach(visibleItems) { item in
                        ProfileActivityCard(container: container, session: session, shell: shell, item: item)
                    }
                }

                if hasMoreItems {
                    Button {
                        visibleCount += batchSize
                    } label: {
                        Text("Carica altre attività")
                            .font(.subheadline.weight(.bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(textPrimary)
                    .background(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(Color(hex: "#F3F4F6"))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(Color.black.opacity(0.08), lineWidth: 1)
                    )
                }
            }
        }
        .modifier(CardChromeModifier(
            isEnabled: embedsInCard,
            padding: 18,
            cornerRadius: 26,
            background: cardBackground,
            border: cardBorder,
            shadowOpacity: 0.10
        ))
    }
}

struct ProfileTasteSection: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let favoriteGenres: [String]
    let entries: [LibraryEntry]
    var embedsInCard = true
    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#4B5563")
    private let cardBackground = Color(hex: "#FCFBF6")
    private let cardBorder = Color.black.opacity(0.08)

    private var cleanedGenres: [String] {
        GenreDisplay.labels(from: favoriteGenres)
    }

    private var topRatedEntries: [LibraryEntry] {
        entries
            .filter { $0.title != nil && $0.lastRating != nil }
            .sorted { lhs, rhs in
                let leftRating = lhs.lastRating ?? 0
                let rightRating = rhs.lastRating ?? 0
                if leftRating != rightRating {
                    return leftRating > rightRating
                }
                return lhs.activitySortDate > rhs.activitySortDate
            }
            .prefix(4)
            .map { $0 }
    }

    private var recentEntries: [LibraryEntry] {
        entries
            .filter { $0.title != nil }
            .sorted { $0.activitySortDate > $1.activitySortDate }
            .prefix(6)
            .map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Taste")
                        .font(.headline)
                        .foregroundStyle(textPrimary)
                    Text("Un colpo d'occhio su gusti, voti forti e ritmo recente.")
                        .font(.caption)
                        .foregroundStyle(textSecondary)
                }
                Spacer()
            }

            if cleanedGenres.isEmpty && topRatedEntries.isEmpty && recentEntries.isEmpty {
                EmptyStateView(
                    title: "Taste ancora da definire",
                    message: "Appena l'utente guarda e vota di più, qui vedremo meglio i suoi segnali.",
                    systemImage: "sparkles"
                )
            } else {
                if cleanedGenres.isEmpty == false {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Generi chiave")
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(textPrimary)
                            ProfileTasteChipsView(items: cleanedGenres)
                        }
                    }
                }

                if topRatedEntries.isEmpty == false {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Top pick")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(textPrimary)

                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 2), spacing: 12) {
                            ForEach(topRatedEntries) { entry in
                                if let title = entry.title {
                                    NavigationLink {
                                        TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                                    } label: {
                                        ProfileTasteHighlightCard(entry: entry, title: title)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }
                }

                if recentEntries.isEmpty == false {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Visti di recente")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(textPrimary)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 12) {
                                ForEach(recentEntries) { entry in
                                    if let title = entry.title {
                                        NavigationLink {
                                            TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                                        } label: {
                                            ProfileRecentPosterCard(entry: entry, title: title)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                            .padding(.trailing, 2)
                        }
                    }
                }
            }
        }
        .modifier(CardChromeModifier(
            isEnabled: embedsInCard,
            padding: 18,
            cornerRadius: 26,
            background: cardBackground,
            border: cardBorder,
            shadowOpacity: 0.10
        ))
    }
}

/// Chip dei generi dentro la card gusti del profilo.
///
/// NON e' il `WrapChipsView` di `UserProfileDetailView`: quello usa la palette
/// scura del tema, questo la palette chiara della paper card del profilo
/// (docs/context/IOS_CODE_STYLE.md §7 — due componenti diversi, non uno da
/// unificare: unificarli cambierebbe l'aspetto di una delle due schermate).
private struct ProfileTasteChipsView: View {
    let items: [String]
    private let textPrimary = Color(hex: "#131826")
    private let chipBackground = Color(hex: "#E5E7EB")

    var body: some View {
        let columns = [GridItem(.adaptive(minimum: 82), spacing: 8, alignment: .center)]

        LazyVGrid(columns: columns, alignment: .center, spacing: 8) {
            ForEach(items, id: \.self) { item in
                Text(item)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(textPrimary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .multilineTextAlignment(.center)
                    .background(chipBackground, in: Capsule())
            }
        }
    }
}
