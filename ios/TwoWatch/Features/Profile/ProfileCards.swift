import SwiftUI

// Card del profilo: tile poster, card attivita', highlight dei gusti,
// poster recenti. Estratte da ProfileComponents.swift.

struct ProfilePosterTile: View {
    let entry: LibraryEntry
    let title: Title
    /// Presente solo per le serie iniziate/finite (mai per i film).
    var seriesProgress: TitleSeriesProgress? = nil
    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#4B5563")
    private let textMuted = Color(hex: "#6B7280")
    private let posterWidth: CGFloat = 108
    private let posterHeight: CGFloat = 162

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topTrailing) {
                PosterImageView(url: title.posterPath, width: posterWidth, height: posterHeight, cornerRadius: 18)
                    .frame(maxWidth: .infinity)

                if let progressLabel {
                    progressBadge(progressLabel)
                        .padding(8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                }

                if entry.completedCount > 1 {
                    rewatchBadge(entry.completedCount)
                        .padding(8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                }

                badge
                    .padding(8)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(title.name)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(textPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)

                Text(title.profileContentCategoryLabel)
                    .font(.caption)
                    .foregroundStyle(textSecondary)
                    .lineLimit(1)

                if entry.activitySortDate != .distantPast {
                    Text(entry.activitySortDate.formatted(date: .abbreviated, time: .omitted))
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(textMuted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 74, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var badge: some View {
        Group {
            if let formattedRating = entry.formattedRating {
                Label(formattedRating, systemImage: "star.fill")
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(TwoWatchTheme.brandPrimary, in: Capsule())
            } else if entry.isInProgress {
                // Serie ancora in corso (non finita): "In corso" invece di "Visto",
                // altrimenti sembrerebbe completata.
                Label("In corso", systemImage: "clock.fill")
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(TwoWatchTheme.brandPrimary, in: Capsule())
            } else {
                Label("Visto", systemImage: "eye.fill")
                    .foregroundStyle(.white)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.72), in: Capsule())
            }
        }
        .font(.caption2.weight(.bold))
    }

    /// Etichetta "a che punto è" per le serie: la presenza di `seriesProgress`
    /// implica già che è una serie iniziata/finita (il film non ha mai progress).
    /// Completa quando il progresso è ~100%, altrimenti `S·E` o `%`.
    private var progressLabel: String? {
        guard let seriesProgress else { return nil }

        // Stato completato → "Completa" anche quando il % non è calcolabile
        // (totali stagioni/episodi assenti).
        if let state = seriesProgress.contextState,
           state == SeriesPersonalStatus.completedUnrated.rawValue
            || state == SeriesPersonalStatus.rated.rawValue {
            return "Completa"
        }

        if let percent = seriesProgress.percentComplete, percent >= 0.999 {
            return "Completa"
        }

        // Guardie > 0: doc storici con 0 letterali o percent 0 (import
        // "in corso a zero") non devono rendere "S0·E0" né "0%" — nessun
        // badge, come la PWA.
        if let season = seriesProgress.lastWatchedSeasonNumber, season > 0,
           let episode = seriesProgress.lastWatchedEpisodeNumber, episode > 0 {
            return "S\(season)·E\(episode)"
        }

        if let percent = seriesProgress.percentComplete, percent > 0 {
            let clamped = max(0, min(1, percent))
            return "\(max(1, Int((clamped * 100).rounded())))%"
        }

        if let season = seriesProgress.lastWatchedSeasonNumber, season > 0 {
            return "S\(season)"
        }

        return nil
    }

    private func progressBadge(_ label: String) -> some View {
        Text(label)
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.black.opacity(0.78), in: Capsule())
            .overlay(
                Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1)
            )
            .accessibilityLabel("A che punto è: \(label)")
    }

    /// Badge rewatch: mostrato quando `completedCount > 1` (più di un giro completo,
    /// rewatch inclusi). Angolo opposto al progresso serie per non sovrapporsi.
    private func rewatchBadge(_ count: Int) -> some View {
        Text("↺ \(count)")
            .font(.caption2.weight(.bold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(TwoWatchTheme.brandSecondary, in: Capsule())
            .overlay(
                Capsule().stroke(Color.white.opacity(0.18), lineWidth: 1)
            )
            .accessibilityLabel("Rivisto \(count) volte")
    }
}

/// Card unica per il timeline "Attività": header con chip tipo + data relativa,
/// poi contenuto specifico per recensione / emozione / post.
struct ProfileActivityCard: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let item: ProfileActivityItem
    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#4B5563")
    private let textMuted = Color(hex: "#6B7280")
    private let cardBackground = Color.white
    private let cardBorder = Color.black.opacity(0.06)

    private var typeLabel: String {
        switch item {
        case .review: return "Recensione"
        case .emotion: return "Emozione"
        case .post: return "Post"
        }
    }

    private var typeIcon: String {
        switch item {
        case .review: return "text.bubble.fill"
        case .emotion: return "face.smiling.fill"
        case .post: return "bubble.left.and.bubble.right.fill"
        }
    }

    private var relativeDateText: String? {
        guard item.sortDate != .distantPast else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.unitsStyle = .short
        return formatter.localizedString(for: item.sortDate, relativeTo: Date())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Label(typeLabel, systemImage: typeIcon)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)

                Spacer()

                if let relativeDateText {
                    Text(relativeDateText)
                        .font(.caption2)
                        .foregroundStyle(textMuted)
                }
            }

            content
        }
        .padding(16)
        .background(cardBackground, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(cardBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 12, y: 6)
    }

    @ViewBuilder
    private var content: some View {
        switch item {
        case let .review(review):
            reviewContent(review)
        case let .emotion(emotion):
            emotionContent(emotion)
        case let .post(post):
            postContent(post)
        }
    }

    @ViewBuilder
    private func reviewContent(_ review: ProfileReviewEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let title = review.title {
                NavigationLink {
                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        PosterImageView(url: title.posterPath, width: 56, height: 84, cornerRadius: 16)

                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 6) {
                                Text(title.name)
                                    .font(.headline)
                                    .foregroundStyle(textPrimary)
                                    .lineLimit(1)

                                if let contextLabel = review.levelContextLabel {
                                    Text(contextLabel)
                                        .font(.caption2.weight(.bold))
                                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(TwoWatchTheme.brandPrimary.opacity(0.12), in: Capsule())
                                }
                            }

                            reviewRatingBadge(review)
                        }

                        Spacer(minLength: 8)
                    }
                }
                .buttonStyle(.plain)
            } else if let contextLabel = review.levelContextLabel {
                Text(contextLabel)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
            }

            if review.reviewText.isEmpty == false {
                ExpandableTextBlock(
                    isExpandable: ExpandableTextHeuristics.needsExpansion(for: review.reviewText, threshold: 240),
                    collapsedLineLimit: 5
                ) { lineLimit in
                    InteractiveTaggedText(
                        source: review.reviewText,
                        font: .subheadline,
                        textColor: textPrimary,
                        lineLimit: lineLimit,
                        container: container,
                        session: session,
                        shell: shell
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            // La recensione vive dentro una discussione: portarci è la cosa
            // che ci si aspetta toccandola. Prima si finiva sulla scheda del
            // titolo, che è un'altra cosa (e resta a un tocco, sul poster).
            reviewDiscussionLink(review)
        }
    }

    /// Discussione in cui questa recensione è stata pubblicata: quella del
    /// titolo, della stagione o dell'episodio, secondo il livello del voto.
    @ViewBuilder
    private func reviewDiscussionLink(_ review: ProfileReviewEntry) -> some View {
        let seed = reviewThreadSeed(review)
        NavigationLink {
            ThreadDetailView(
                container: container,
                session: session,
                shell: shell,
                threadID: reviewThreadID(review),
                publicThreadSeed: seed
            )
        } label: {
            HStack(spacing: 5) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 11, weight: .bold))
                Text(discussionLinkLabel(review))
                    .font(.caption.weight(.bold))
                Image(systemName: "arrow.right")
                    .font(.system(size: 10, weight: .heavy))
                Spacer(minLength: 0)
            }
            .foregroundStyle(TwoWatchTheme.brandPrimary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func discussionLinkLabel(_ review: ProfileReviewEntry) -> String {
        switch (review.level, review.season, review.episode) {
        case ("episode", .some(let s), .some(let e)):
            return "Vai alla discussione di S\(s)E\(e)"
        case ("season", .some(let s), _):
            return "Vai alla discussione della stagione \(s)"
        default:
            return "Vai alla discussione"
        }
    }

    private func reviewThreadSeed(_ review: ProfileReviewEntry) -> PublicThreadSeed {
        switch (review.level, review.season, review.episode) {
        case ("episode", .some(let s), .some(let e)):
            return .episode(titleID: review.titleId, season: s, episode: e)
        case ("season", .some(let s), _):
            return .season(titleID: review.titleId, season: s)
        default:
            return .title(review.titleId)
        }
    }

    private func reviewThreadID(_ review: ProfileReviewEntry) -> String {
        let repository = container.threadsRepository
        switch (review.level, review.season, review.episode) {
        case ("episode", .some(let s), .some(let e)):
            return repository.threadIDForEpisode(titleID: review.titleId, season: s, episode: e)
        case ("season", .some(let s), _):
            return repository.threadIDForSeason(titleID: review.titleId, season: s)
        default:
            return repository.threadIDForPublic(titleID: review.titleId)
        }
    }

    private func reviewRatingBadge(_ review: ProfileReviewEntry) -> some View {
        Label(review.formattedRating, systemImage: "star.fill")
            .font(.caption.weight(.bold))
            .foregroundStyle(TwoWatchTheme.brandPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(TwoWatchTheme.brandPrimary.opacity(0.12), in: Capsule())
    }

    @ViewBuilder
    private func emotionContent(_ emotion: TitleEmotionEntry) -> some View {
        if let title = emotion.title {
            NavigationLink {
                TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    PosterImageView(url: title.posterPath, width: 56, height: 84, cornerRadius: 16)

                    VStack(alignment: .leading, spacing: 6) {
                        Text(title.name)
                            .font(.headline)
                            .foregroundStyle(textPrimary)
                            .lineLimit(1)

                        HStack(spacing: 6) {
                            ForEach(emotion.emotions) { singleEmotion in
                                Text(singleEmotion.emoji)
                                    .font(.title3)
                            }
                        }
                    }

                    Spacer(minLength: 8)
                }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func postContent(_ post: AppPost) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let text = post.text, text.isEmpty == false {
                // I titoli taggati sono salvati come `#[Nome](titleId)`: con un
                // `Text` semplice quel markup arrivava a schermo così com'è.
                // `InteractiveTaggedText` lo rende colorato e tappabile, come
                // ovunque altro nell'app.
                ExpandableTextBlock(
                    isExpandable: ExpandableTextHeuristics.needsExpansion(for: text, threshold: 240),
                    collapsedLineLimit: 4
                ) { lineLimit in
                    InteractiveTaggedText(
                        source: text,
                        font: .subheadline,
                        textColor: textPrimary,
                        lineLimit: lineLimit,
                        container: container,
                        session: session,
                        shell: shell
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            HStack(spacing: 8) {
                if let title = post.title {
                    NavigationLink {
                        TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "film.fill")
                                .font(.caption2)
                            Text(title.name)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                        }
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(TwoWatchTheme.brandPrimary.opacity(0.1), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }

                Spacer(minLength: 0)

                // Il post ha una sua pagina con i commenti: prima da qui non
                // era raggiungibile in alcun modo.
                NavigationLink {
                    PostDetailView(container: container, session: session, shell: shell, postID: post.id)
                } label: {
                    HStack(spacing: 5) {
                        Text("Apri il post")
                            .font(.caption.weight(.bold))
                        Image(systemName: "arrow.right")
                            .font(.system(size: 10, weight: .heavy))
                    }
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct ProfileTasteHighlightCard: View {
    let entry: LibraryEntry
    let title: Title
    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#4B5563")
    private let cardBackground = Color.white
    private let cardBorder = Color.black.opacity(0.06)

    private var genreSummary: String {
        let genres = GenreDisplay.labels(from: title.genres)
        return genres.isEmpty ? title.subtitle : genres.prefix(2).joined(separator: " • ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            PosterImageView(url: title.posterPath, width: 54, height: 80, cornerRadius: 14)

            VStack(alignment: .leading, spacing: 6) {
                Text(title.name)
                    .font(.caption.weight(.bold))
                    .foregroundStyle(textPrimary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.82)

                Text(genreSummary)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(textSecondary)
                    .lineLimit(2)

                if let formattedRating = entry.formattedRating {
                    Label(formattedRating, systemImage: "star.fill")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(cardBackground, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(cardBorder, lineWidth: 1)
        )
    }
}

struct ProfileRecentPosterCard: View {
    let entry: LibraryEntry
    let title: Title
    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#4B5563")

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PosterImageView(url: title.posterPath, width: 110, height: 164, cornerRadius: 18)

            Text(title.name)
                .font(.caption.weight(.semibold))
                .foregroundStyle(textPrimary)
                .lineLimit(2)

            if entry.activitySortDate != .distantPast {
                Text(entry.activitySortDate.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption2)
                    .foregroundStyle(textSecondary)
            }
        }
        .frame(width: 110, alignment: .leading)
    }
}
