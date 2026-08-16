import PhotosUI
import SwiftUI
import UIKit

// Testata della scheda titolo e blocco "il mio stato": hero, banner nuova
// stagione, controllo stato serie, e il foglio delle azioni di visione.
// Estratti da TitleDetailView.swift, spostamento puro.

struct TitlePersonalTrackingSection: View {
    let title: Title
    let personalState: TitlePersonalState?
    let isAuthenticated: Bool
    let onRequireAuth: () -> Void
    let onOpenWatchActions: () -> Void
    let onOpenRatingComposer: () -> Void
    let onMarkMovieSeen: () -> Void
    /// Chiamato dopo conferma: riporta il titolo a "Da vedere" (e cancella il
    /// voto generale se presente). Gestisce sia film sia serie a monte.
    let onConfirmUnsee: () -> Void
    let onToggleWatchlist: () -> Void
    let onMarkSeriesEpisode: () -> Void
    let onMarkSeriesSeason: () -> Void
    let onMarkSeriesCompleted: () -> Void
    let onSetRewatchIntent: (Bool) -> Void
    let onAcknowledgeNewContent: () -> Void
    let onResumeFromNewContent: () -> Void

    @State private var pendingSeriesSegment: SeriesPersonalStatus?
    @State private var isConfirmingUnsee = false

    private struct SeasonNotice {
        let seasonNumber: Int
        let airDate: String?
        let sourceURL: URL?
    }

    /// Distingue tra stagione realmente riprendibile e stagione solo annunciata.
    /// TMDB può esporre stagioni future prima che siano guardabili.
    private func baseNewSeasonRows(after state: TitlePersonalState) -> [TitleSeason] {
        guard title.type == .tv,
              state.isInRewatch == false,
              state.seriesStatus == .completedUnrated || state.seriesStatus == .rated,
              let snapshotSeasons = state.completedAtTotalSeasons, snapshotSeasons > 0
        else { return [] }

        if !title.metadata.seasons.isEmpty {
            return title.metadata.seasons
                .filter { $0.seasonNumber > snapshotSeasons }
                .sorted { $0.seasonNumber < $1.seasonNumber }
        }

        guard let currentSeasons = title.metadata.seasonsCount, currentSeasons > snapshotSeasons else { return [] }
        return ((snapshotSeasons + 1) ... currentSeasons).map {
            TitleSeason(seasonNumber: $0, episodeCount: 0, name: nil)
        }
    }

    private func availableNewSeason(for state: TitlePersonalState) -> SeasonNotice? {
        let rows = baseNewSeasonRows(after: state)
        if let season = rows.last(where: { isSeasonAvailable($0) }) {
            return notice(for: season)
        }

        guard state.canResumeFromNewContent,
              let number = state.latestSeasonNumber ?? rows.last?.seasonNumber,
              seasonAirDateIsAvailable(state.latestSeasonAirDate)
        else { return nil }

        return SeasonNotice(
            seasonNumber: number,
            airDate: state.latestSeasonAirDate,
            sourceURL: tmdbSeasonURL(seasonNumber: number)
        )
    }

    private func announcedNewSeason(for state: TitlePersonalState) -> SeasonNotice? {
        guard let season = baseNewSeasonRows(after: state).last,
              !isSeasonAvailable(season)
        else { return nil }
        return notice(for: season)
    }

    private func notice(for season: TitleSeason) -> SeasonNotice {
        SeasonNotice(
            seasonNumber: season.seasonNumber,
            airDate: season.airDate,
            sourceURL: tmdbSeasonURL(seasonNumber: season.seasonNumber)
        )
    }

    private func isSeasonAvailable(_ season: TitleSeason) -> Bool {
        if seasonAirDateIsAvailable(season.airDate) {
            return true
        }
        return season.airDate == nil && season.episodeCount > 0
    }

    private func seasonAirDateIsAvailable(_ raw: String?) -> Bool {
        guard let raw, !raw.isEmpty else { return false }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        guard let date = formatter.date(from: raw) else { return false }
        let calendar = Calendar.current
        return calendar.startOfDay(for: date) <= calendar.startOfDay(for: Date())
    }

    private func tmdbSeasonURL(seasonNumber: Int) -> URL? {
        guard let tmdbId = title.metadata.tmdbId, tmdbId > 0, seasonNumber > 0 else { return nil }
        return URL(string: "https://www.themoviedb.org/tv/\(tmdbId)/season/\(seasonNumber)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let personalState {
                if let notice = availableNewSeason(for: personalState) {
                    NewSeasonBanner(
                        latestSeasonNumber: notice.seasonNumber,
                        latestSeasonAirDate: notice.airDate,
                        sourceURL: notice.sourceURL,
                        onResume: {
                            if isAuthenticated { onResumeFromNewContent() } else { onRequireAuth() }
                        },
                        onDismiss: {
                            if isAuthenticated { onAcknowledgeNewContent() } else { onRequireAuth() }
                        }
                    )
                } else if let notice = announcedNewSeason(for: personalState) {
                    AnnouncedSeasonBanner(
                        latestSeasonNumber: notice.seasonNumber,
                        latestSeasonAirDate: notice.airDate,
                        sourceURL: notice.sourceURL
                    )
                }
            }

            if title.type == .movie {
                SomtoMovieProgressModule(
                    personalState: personalState,
                    runtimeMinutes: title.metadata.durationMovie,
                    watchedMinutes: nil,
                    isAuthenticated: isAuthenticated,
                    onRequireAuth: onRequireAuth,
                    onMarkSeen: onMarkMovieSeen,
                    onMarkUnseen: { isConfirmingUnsee = true },
                    onOpenMoreActions: { isAuthenticated ? onOpenWatchActions() : onRequireAuth() }
                )
            } else {
                SomtoSeriesProgressModule(
                    personalState: personalState,
                    seriesProgress: personalState?.seriesProgress,
                    isAuthenticated: isAuthenticated,
                    onRequireAuth: onRequireAuth,
                    onMarkEpisode: onMarkSeriesEpisode,
                    onOpenMoreActions: { isAuthenticated ? onOpenWatchActions() : onRequireAuth() }
                )
            }

            if !isAuthenticated {
                Button("Accedi per tracciare") { onRequireAuth() }
                    .buttonStyle(PrimaryButtonStyle())
            }
        }
        .confirmationDialog(
            unseeConfirmationTitle,
            isPresented: $isConfirmingUnsee,
            titleVisibility: .visible
        ) {
            Button(unseeConfirmationButtonLabel, role: .destructive) {
                onConfirmUnsee()
            }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text(unseeConfirmationMessage)
        }
    }

    private var hasTitleRating: Bool {
        personalState?.isRated == true
    }

    private var unseeConfirmationTitle: String {
        title.type == .movie ? String(localized: "Segnare come non visto?") : String(localized: "Riazzerare il progresso?")
    }

    private var unseeConfirmationButtonLabel: String {
        hasTitleRating ? "Rimuovi voto e visto" : (title.type == .movie ? "Segna non visto" : "Riazzera")
    }

    private var unseeConfirmationMessage: String {
        switch title.type {
        case .movie:
            return hasTitleRating
                ? String(localized: "Il film tornerà tra i titoli da vedere e il tuo voto verrà rimosso.")
                : String(localized: "Il film tornerà tra i titoli da vedere.")
        case .tv:
            return hasTitleRating
                ? String(localized: "La serie tornerà a 'Da vedere': gli episodi tracciati e il tuo voto verranno rimossi.")
                : String(localized: "La serie tornerà a 'Da vedere' e gli episodi tracciati verranno rimossi.")
        }
    }

    private func handleSeriesSegmentSelection(_ selected: SeriesPersonalStatus, current: SeriesPersonalStatus) {
        if selected == current { return }
        switch selected {
        case .notStarted:
            // Destructive: confirm.
            pendingSeriesSegment = .notStarted
        case .inProgress:
            if current == .notStarted {
                onMarkSeriesEpisode()
            } else if current == .completedUnrated {
                // Resume from completion: catch-up via mark_series_episode (handled server-side).
                onMarkSeriesEpisode()
            }
        case .completedUnrated, .rated:
            onMarkSeriesCompleted()
        }
    }

    private var emptyStateCopy: String {
        if title.type == .movie {
            return String(localized: "Quando lo guardi puoi segnarlo subito come visto, anche senza lasciare un voto.")
        }
        return String(localized: "Tieni il conto di episodi, stagioni e completamento anche senza votare subito la serie.")
    }

    private func summaryText(for personalState: TitlePersonalState) -> String {
        if personalState.canResumeFromNewContent {
            return String(localized: "Hai una nuova stagione da recuperare. I minuti già visti restano congelati finché non riprendi.")
        }
        if personalState.isInRewatch {
            return String(localized: "Rewatch attivo. Il prossimo completamento aggiunge una visione allo storico.")
        }
        if personalState.isCompleted && !personalState.isRated {
            return String(localized: "Visto. Vota quando vuoi, niente fretta.")
        }
        if personalState.isInProgressSeries {
            return "Aggiorna episodi e stagioni dal tab Episodi."
        }
        if personalState.generalWatchlist && !personalState.hasStartedWatching {
            return String(localized: "Salvato in 'Da vedere'. Inizia quando vuoi.")
        }
        return personalState.statusSubtitle
    }

    private func metaItems(for personalState: TitlePersonalState) -> [(text: String, systemName: String)] {
        var items: [(String, String)] = []

        if let progressText = personalState.progressText, !progressText.isEmpty {
            items.append((progressText, "chart.bar.fill"))
        }

        if personalState.completedCount > 1 {
            items.append(("\(personalState.completedCount - 1) rewatch", "arrow.counterclockwise"))
        }

        if personalState.watchMinutesContribution > 0 {
            items.append((watchMinutesText(personalState.watchMinutesContribution), "clock.fill"))
        }

        return items
    }

    private func watchMinutesText(_ totalMinutes: Int) -> String {
        let minutes = max(0, totalMinutes)
        let hours = minutes / 60
        let remainder = minutes % 60

        if hours > 0 && remainder > 0 {
            return "\(hours) h \(remainder) min"
        }
        if hours > 0 {
            return "\(hours) h"
        }
        return "\(remainder) min"
    }

    private func statusTint(for personalState: TitlePersonalState) -> Color {
        if personalState.canResumeFromNewContent {
            return TwoWatchTheme.brandWarm
        }
        switch personalState.statusValue {
        case MoviePersonalStatus.rated.rawValue, SeriesPersonalStatus.rated.rawValue:
            return TwoWatchTheme.success
        case MoviePersonalStatus.seenUnrated.rawValue, SeriesPersonalStatus.completedUnrated.rawValue:
            return TwoWatchTheme.success
        case SeriesPersonalStatus.inProgress.rawValue:
            return TwoWatchTheme.accent
        default:
            return TwoWatchTheme.brandWarm
        }
    }
}

private struct SeriesStatusSegmentedControl: View {
    let current: SeriesPersonalStatus
    let onSelect: (SeriesPersonalStatus) -> Void

    private var options: [(SeriesPersonalStatus, String)] {
        [(.notStarted, "Da vedere"), (.inProgress, "In corso"), (.completedUnrated, "In pari")]
    }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(options, id: \.0) { value, label in
                Button {
                    onSelect(value)
                } label: {
                    Text(label)
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .foregroundStyle(value == current ? Color.white : TwoWatchTheme.textSecondary)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(value == current ? TwoWatchTheme.accent : TwoWatchTheme.panelStrong)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(TwoWatchTheme.border, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(value == current ? .isSelected : [])
            }
        }
    }
}

private struct NewSeasonBanner: View {
    let latestSeasonNumber: Int?
    let latestSeasonAirDate: String?
    let sourceURL: URL?
    let onResume: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "sparkles.tv.fill")
                    .foregroundStyle(TwoWatchTheme.brandWarm)
                Text(headline)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer(minLength: 0)
            }

            if let subline {
                Text(subline)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            HStack(spacing: 10) {
                Button("Riprendi", action: onResume)
                    .buttonStyle(PrimaryButtonStyle())
                Button("Forse dopo", action: onDismiss)
                    .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.textMuted))
            }

            if let sourceURL {
                Link(destination: sourceURL) {
                    Label("Scheda TMDB", systemImage: "arrow.up.right")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(TwoWatchTheme.brandWarm)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.brandWarm.opacity(0.12))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.brandWarm.opacity(0.45), lineWidth: 1)
        )
    }

    private var headline: String {
        if let latestSeasonNumber, latestSeasonNumber > 0 {
            return "Stagione \(latestSeasonNumber) disponibile"
        }
        return "Nuovi episodi disponibili"
    }

    private var subline: String? {
        guard let latestSeasonAirDate, !latestSeasonAirDate.isEmpty else { return nil }
        return "In onda dal \(latestSeasonAirDate)"
    }
}

private struct AnnouncedSeasonBanner: View {
    let latestSeasonNumber: Int
    let latestSeasonAirDate: String?
    let sourceURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "calendar.badge.clock")
                    .foregroundStyle(TwoWatchTheme.accent)
                Text("Stagione \(latestSeasonNumber) annunciata")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer(minLength: 0)
            }

            Text(subline)
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textMuted)

            if let sourceURL {
                Link(destination: sourceURL) {
                    Label("Apri scheda TMDB", systemImage: "arrow.up.right")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(TwoWatchTheme.accent)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(TwoWatchTheme.accent.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.accent.opacity(0.2), lineWidth: 1)
        )
    }

    private var subline: String {
        guard let latestSeasonAirDate, !latestSeasonAirDate.isEmpty else {
            return String(localized: "Non risulta ancora disponibile su TMDB.")
        }
        return "Data indicata da TMDB: \(latestSeasonAirDate)"
    }
}

private struct TitlePersonalTrackingMetaChip: View {
    let text: String
    let systemName: String

    var body: some View {
        Label(text, systemImage: systemName)
            .font(.caption.weight(.semibold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(TwoWatchTheme.panelStrong, in: Capsule())
            .overlay(
                Capsule()
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
    }
}

struct TitleHeroHeader: View {
    let title: Title
    let subtitle: String
    let originalTitle: String?
    let genres: [String]
    let personalState: TitlePersonalState?
    let isInWatchlist: Bool
    let isInRewatch: Bool
    let userRating: Double?
    let communityAverageText: String
    let communityVotesCount: Int
    let friendsAverageText: String
    let friendsVotesCount: Int
    let expertsAverageText: String
    let expertsVotesCount: Int
    let topSafeArea: CGFloat
    let availableWidth: CGFloat
    let onToggleWatchlist: () -> Void
    let onOpenWatchActions: () -> Void
    let onOpenRatingComposer: () -> Void
    let onOpenFriendsVotes: () -> Void

    @State private var isCommunityHintVisible = false

    private var isCompactWidth: Bool {
        availableWidth <= 430
    }

    private var posterSize: CGSize {
        isCompactWidth ? CGSize(width: 108, height: 162) : CGSize(width: 124, height: 186)
    }

    private var heroHeight: CGFloat {
        isCompactWidth ? max(456, topSafeArea + 408) : max(404, topSafeArea + 368)
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            TitleBackdropImage(title: title)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            LinearGradient(
                colors: [
                    Color.black.opacity(0.1),
                    Color.black.opacity(0.28),
                    Color.black.opacity(0.82),
                    TwoWatchTheme.background
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            RadialGradient(
                colors: [Color.clear, Color.black.opacity(0.34)],
                center: .topTrailing,
                startRadius: 24,
                endRadius: 420
            )

            VStack(alignment: .leading, spacing: 0) {
                heroTopBar
                    .padding(.bottom, 18)

                Spacer(minLength: 0)

                Group {
                    if isCompactWidth {
                        VStack(alignment: .leading, spacing: 16) {
                            PosterImageView(
                                url: title.posterPath,
                                width: posterSize.width,
                                height: posterSize.height,
                                cornerRadius: 24
                            )

                            heroTextContent
                        }
                    } else {
                        HStack(alignment: .bottom, spacing: 16) {
                            PosterImageView(
                                url: title.posterPath,
                                width: posterSize.width,
                                height: posterSize.height,
                                cornerRadius: 24
                            )

                            heroTextContent
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
            }
            .padding(.horizontal, isCompactWidth ? 18 : 20)
            .padding(.top, 10)
            .padding(.bottom, isCompactWidth ? 24 : 28)
        }
        .frame(height: heroHeight)
        .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 34, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.3), radius: 24, y: 18)
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    private var heroTextContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.name)
                .font(.system(size: isCompactWidth ? 30 : 34, weight: .black, design: .rounded))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(4)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .shadow(color: .black.opacity(0.4), radius: 12, y: 6)
                .layoutPriority(1)

            if let originalTitle {
                Text(originalTitle)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(subtitle)
                .font(.headline.weight(.semibold))
                .foregroundStyle(Color.white.opacity(0.88))
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                heroVoteChip
                if let personalState {
                    StatusChip(
                        text: personalState.statusTitle,
                        tint: statusTint(for: personalState)
                    )
                    if personalState.generalWatchlist {
                        StatusChip(text: "Watchlist", tint: TwoWatchTheme.accent)
                    } else if personalState.isInRewatch {
                        StatusChip(text: "Rewatch", tint: TwoWatchTheme.brandWarm)
                    }
                }
            }

            if let duration = TitleDetailFormatter.duration(for: title) {
                HStack(spacing: 8) {
                    Image(systemName: "clock.fill")
                        .font(.caption.weight(.bold))
                    Text(duration)
                        .font(.subheadline.weight(.semibold))
                }
                .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            HStack(alignment: .top, spacing: 12) {
                if !genres.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Array(genres.prefix(isCompactWidth ? 2 : 3)), id: \.self) { genre in
                                TitleCapsuleLabel(text: genre)
                            }
                        }
                    }
                    .scrollClipDisabled()
                }

                Spacer(minLength: 0)

                HStack(alignment: .top, spacing: 10) {
                    Button(action: onOpenFriendsVotes) {
                        TitleHeroStat(
                            systemName: "person.2.fill",
                            value: friendsAverageText,
                            tint: TwoWatchTheme.accent,
                            isEnabled: friendsVotesCount > 0,
                            caption: "Chi segui"
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(friendsVotesCount == 0)
                    .accessibilityLabel(
                        friendsVotesCount > 0
                            ? "Media di chi segui: \(friendsAverageText) su 10, \(friendsVotesCount) voti"
                            : "Nessun voto da chi segui"
                    )

                    TitleHeroStat(
                        systemName: "person.3.fill",
                        value: communityAverageText,
                        tint: TwoWatchTheme.brandWarm,
                        isEnabled: communityVotesCount > 0,
                        caption: "Community"
                    )
                    .accessibilityLabel(
                        communityVotesCount > 0
                            ? "Media della community: \(communityAverageText) su 10, \(communityVotesCount) voti"
                            : "Nessun voto dalla community"
                    )

                    // Solo quando c'è davvero un voto da esperti: prima la
                    // terza pastiglia era sempre lì con un trattino, e il tap
                    // mostrava per errore il tooltip della community.
                    if expertsVotesCount > 0 {
                        TitleHeroStat(
                            systemName: "graduationcap.fill",
                            value: expertsAverageText,
                            tint: TwoWatchTheme.success,
                            isEnabled: true,
                            caption: "Critica"
                        )
                        .accessibilityLabel("Media della critica: \(expertsAverageText) su 10")
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var heroTopBar: some View {
        HStack(alignment: .center, spacing: 8) {
            TitleBadge(text: title.type.label, tint: TwoWatchTheme.accent)

            if let year = title.year {
                TitleBadge(text: String(year), tint: TwoWatchTheme.brandWarm)
            }

            // Film appena uscito (anno corrente): badge NUOVO. Per le serie il
            // "nuovo" è a livello di stagione (badge sulla card + NewSeasonBanner).
            if title.type == .movie, TitleReleaseFreshness.isRecent(movieYear: title.year) {
                NewReleaseBadge()
            }

            Spacer(minLength: 0)

            TitleHeroIconButton(
                systemName: isInRewatch ? "arrow.counterclockwise.circle.fill" : (isInWatchlist ? "bookmark.fill" : "bookmark"),
                tint: isInRewatch ? TwoWatchTheme.brandWarm : (isInWatchlist ? TwoWatchTheme.success : Color.white),
                accessibilityLabel: isInRewatch ? "Rimuovi dal rewatch" : (isInWatchlist ? "Rimuovi dalla watchlist" : "Aggiungi alla watchlist"),
                action: onToggleWatchlist
            )

            TitleHeroIconButton(
                systemName: "ellipsis.circle.fill",
                tint: Color.white,
                accessibilityLabel: String(localized: "Apri le azioni del titolo"),
                action: onOpenWatchActions
            )

            TitleHeroIconButton(
                systemName: "star.fill",
                title: userRating.map(TitleDetailFormatter.rating) ?? "Vota",
                tint: TwoWatchTheme.warning,
                accessibilityLabel: userRating == nil ? String(localized: "Valuta il titolo") : String(localized: "Aggiorna il voto"),
                action: onOpenRatingComposer
            )
        }
    }

    @ViewBuilder
    private var heroVoteChip: some View {
        if let userRating {
            // Voto già dato: chip sobria che mostra il valore. Tap per modificare.
            Button(action: onOpenRatingComposer) {
                HStack(spacing: 4) {
                    Image(systemName: "star.fill")
                        .font(.caption2.weight(.bold))
                    Text("Il tuo voto: \(TitleDetailFormatter.rating(userRating))")
                        .font(.system(size: 13, weight: .bold, design: .rounded))
                        .monospacedDigit()
                }
                .foregroundStyle(TwoWatchTheme.accent)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(TwoWatchTheme.accent.opacity(0.18), in: Capsule())
                .overlay(Capsule().stroke(TwoWatchTheme.accent.opacity(0.45), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(String(localized: "Hai dato \(TitleDetailFormatter.rating(userRating)) su 10. Tocca per aggiornare il voto."))
        } else {
            // Nessun voto: CTA evidente, brand cyan, ALL CAPS-ish per richiamare l'azione.
            Button(action: onOpenRatingComposer) {
                HStack(spacing: 5) {
                    Image(systemName: "star.fill")
                        .font(.caption.weight(.heavy))
                    Text("Vota")
                        .font(.system(size: 13, weight: .heavy, design: .rounded))
                        .tracking(0.3)
                }
                .foregroundStyle(Color.black)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(TwoWatchTheme.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Vota questo titolo")
        }
    }

    private func showCommunityHint() {
        withAnimation(.easeOut(duration: 0.18)) {
            isCommunityHintVisible = true
        }

        Task {
            try? await Task.sleep(for: .seconds(1.4))
            await MainActor.run {
                withAnimation(.easeIn(duration: 0.18)) {
                    isCommunityHintVisible = false
                }
            }
        }
    }

    private func statusTint(for personalState: TitlePersonalState) -> Color {
        switch personalState.statusValue {
        case MoviePersonalStatus.rated.rawValue, SeriesPersonalStatus.rated.rawValue:
            return TwoWatchTheme.success
        case MoviePersonalStatus.seenUnrated.rawValue, SeriesPersonalStatus.completedUnrated.rawValue:
            return TwoWatchTheme.warning
        case SeriesPersonalStatus.inProgress.rawValue:
            return TwoWatchTheme.accent
        default:
            return TwoWatchTheme.brandWarm
        }
    }

}

struct TitleWatchActionsSheet: View {
    let title: Title
    let session: SessionStore
    @Bindable var viewModel: TitleDetailViewModel
    let onRequireAuth: () -> Void
    let onMarkSeriesEpisode: (String) -> Void
    let onOpenRatingComposer: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var quickListName = ""
    @State private var quickListVisibility: UserListVisibility = .private
    @State private var quickListKind: UserListKind = .collection
    @State private var isConfirmingRemoveRating = false
    @State private var isConfirmingUnsee = false

    private var personalState: TitlePersonalState? {
        viewModel.personalState
    }

    private var canRemoveRating: Bool {
        personalState?.isRated == true
    }

    private var canMarkUnseen: Bool {
        personalState?.isCompleted == true
    }

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 16) {
                    watchStateCard
                    if canRemoveRating || canMarkUnseen {
                        reversibilityCard
                    }
                    listActionsCard
                    quickCreateCard
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 28)
            }
            .background(TwoWatchBackground())
            .navigationTitle("Gestisci titolo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
            .confirmationDialog(
                "Rimuovere il voto?",
                isPresented: $isConfirmingRemoveRating,
                titleVisibility: .visible
            ) {
                Button("Rimuovi voto", role: .destructive) {
                    withUserID { uid in
                        Task { await viewModel.deleteTitleRating(userID: uid) }
                    }
                }
                Button("Annulla", role: .cancel) {}
            } message: {
                Text("Il titolo resta tra i visti, ma senza voto. Potrai rivotarlo quando vuoi.")
            }
            .confirmationDialog(
                unseeTitle,
                isPresented: $isConfirmingUnsee,
                titleVisibility: .visible
            ) {
                Button(canRemoveRating ? "Rimuovi voto e visto" : unseeButtonLabel, role: .destructive) {
                    withUserID { uid in
                        Task {
                            await viewModel.markUnseen(userID: uid)
                            dismiss()
                        }
                    }
                }
                Button("Annulla", role: .cancel) {}
            } message: {
                Text(unseeMessage)
            }
        }
        .presentationDetents([.fraction(0.78), .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(TwoWatchTheme.panelStrong)
    }

    private var unseeTitle: String {
        title.type == .movie ? String(localized: "Segnare come non visto?") : String(localized: "Riazzerare il progresso?")
    }

    private var unseeButtonLabel: String {
        title.type == .movie ? "Segna non visto" : "Riazzera"
    }

    private var unseeMessage: String {
        switch title.type {
        case .movie:
            return canRemoveRating
                ? String(localized: "Il film tornerà tra i titoli da vedere e il tuo voto verrà rimosso.")
                : String(localized: "Il film tornerà tra i titoli da vedere.")
        case .tv:
            return canRemoveRating
                ? String(localized: "La serie tornerà a 'Da vedere': gli episodi tracciati e il tuo voto verranno rimossi.")
                : String(localized: "La serie tornerà a 'Da vedere' e gli episodi tracciati verranno rimossi.")
        }
    }

    private var reversibilityCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Annulla",
                    subtitle: String(localized: "Hai cambiato idea? Puoi rimuovere il voto o riportare il titolo tra quelli da vedere.")
                )

                if canRemoveRating {
                    reversibilityRow(
                        icon: "star.slash.fill",
                        label: "Rimuovi voto",
                        detail: String(localized: "Il titolo resta tra i visti, senza voto."),
                        tint: TwoWatchTheme.warning
                    ) {
                        isConfirmingRemoveRating = true
                    }
                }

                if canMarkUnseen {
                    reversibilityRow(
                        icon: "eye.slash.fill",
                        label: "Segna come non visto",
                        detail: title.type == .movie
                            ? "Torna in 'Da vedere'."
                            : String(localized: "Torna in 'Da vedere' (azzera gli episodi tracciati)."),
                        tint: TwoWatchTheme.brandWarm
                    ) {
                        isConfirmingUnsee = true
                    }
                }
            }
        }
    }

    private func reversibilityRow(
        icon: String,
        label: String,
        detail: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.headline.weight(.bold))
                    .foregroundStyle(tint)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 3) {
                    Text(label)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .accessibilityHidden(true)
            }
            .padding(14)
            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private var headerCard: some View {
        GlassCard {
            HStack(alignment: .top, spacing: 14) {
                PosterImageView(url: title.posterPath, width: 88, height: 132, cornerRadius: 22)

                VStack(alignment: .leading, spacing: 8) {
                    Text(title.name)
                        .font(.title3.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textPrimary)

                    Text(title.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)

                    if let personalState {
                        HStack(spacing: 8) {
                            StatusChip(text: personalState.statusTitle, tint: statusTint)
                            if personalState.generalWatchlist {
                                StatusChip(text: "Watchlist", tint: TwoWatchTheme.accent)
                            } else if personalState.isInRewatch {
                                StatusChip(text: "Rewatch", tint: TwoWatchTheme.brandWarm)
                            }
                        }
                    } else {
                        Text("Non ancora organizzato nella tua libreria.")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }

                    if let progressText = personalState?.progressText {
                        Label(progressText, systemImage: "chart.bar.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.accent)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var watchStateCard: some View {
        // Single column with section heads. No nested cards. 8pt rhythm.
        VStack(alignment: .leading, spacing: 22) {
            sectionHeader("Azioni rapide", subtitle: title.type == .movie
                ? String(localized: "Marca lo stato in un tocco.")
                : String(localized: "Avanza nel percorso senza aprire il tab episodi."))
            quickActionsGrid

            sectionHeader("Voto", subtitle: String(localized: "Apri il composer per dare un giudizio o registra la visione adesso."))
            voteRow

            if personalState?.isCompleted != true {
                helperHint
            }
        }
        .padding(.horizontal, 4)
    }

    private func sectionHeader(_ title: String, subtitle: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .heavy, design: .rounded))
                .tracking(0.6)
                .foregroundStyle(TwoWatchTheme.textMuted)
            if let subtitle {
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var voteRow: some View {
        HStack(spacing: 10) {
            Button {
                dismiss()
                onOpenRatingComposer()
            } label: {
                Label(personalState?.isRated == true ? "Modifica voto" : "Vota ora", systemImage: "star.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(Color.black)
                    .background(TwoWatchTheme.accent, in: Capsule())
            }
            .buttonStyle(.plain)

            Button {
                withUserID { uid in
                    Task { await viewModel.deferRating(userID: uid) }
                }
            } label: {
                Text("Vota più tardi")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(!(personalState?.isCompleted ?? false))
            .opacity((personalState?.isCompleted ?? false) ? 1 : 0.4)
        }
    }

    private var helperHint: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textMuted)
                .padding(.top, 2)
            Text(personalState?.hasStartedWatching == true
                 ? "I titoli già visti non rientrano in Da vedere: tienili in Rewatch o nelle tue liste."
                 : "Quando lo segni come visto, esce automaticamente da Da vedere.")
                .font(.caption)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func stateSegment(_ label: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(isActive ? Color.black : TwoWatchTheme.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(isActive ? AnyShapeStyle(TwoWatchTheme.accent) : AnyShapeStyle(TwoWatchTheme.panelStrong), in: Capsule())
                .overlay(Capsule().stroke(isActive ? Color.clear : TwoWatchTheme.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var quickActionsGrid: some View {
        let columns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        LazyVGrid(columns: columns, spacing: 10) {
            if title.type == .movie {
                actionTile(
                    icon: "checkmark.seal.fill",
                    label: personalState?.isCompleted == true ? String(localized: "Già visto") : "Segna visto",
                    tint: TwoWatchTheme.success,
                    isActive: personalState?.isCompleted == true
                ) {
                    withUserID { uid in
                        Task { await viewModel.markMovieSeen(userID: uid) }
                    }
                }
                actionTile(
                    icon: "bookmark.fill",
                    label: personalState?.generalWatchlist == true ? "In Watchlist" : "Aggiungi",
                    tint: TwoWatchTheme.accent,
                    isActive: personalState?.generalWatchlist == true
                ) {
                    withUserID { uid in
                        Task { await viewModel.toggleWatchlist(userID: uid) }
                    }
                }
                actionTile(
                    icon: "arrow.counterclockwise",
                    label: personalState?.isInRewatch == true ? "Rewatch on" : "Rewatch",
                    tint: TwoWatchTheme.brandWarm,
                    isActive: personalState?.isInRewatch == true
                ) {
                    withUserID { uid in
                        Task {
                            await viewModel.setRewatchIntent(userID: uid, isIncluded: !(personalState?.isInRewatch ?? false))
                        }
                    }
                }
                actionTile(
                    icon: "star.fill",
                    label: personalState?.isRated == true ? "Modifica voto" : "Vota",
                    tint: TwoWatchTheme.warning,
                    isActive: personalState?.isRated == true
                ) {
                    dismiss()
                    onOpenRatingComposer()
                }
            } else {
                actionTile(
                    icon: "plus.circle.fill",
                    label: "Episodio",
                    tint: TwoWatchTheme.accent,
                    isActive: false
                ) {
                    withUserID { uid in
                        dismiss()
                        onMarkSeriesEpisode(uid)
                    }
                }
                actionTile(
                    icon: "rectangle.stack.fill.badge.plus",
                    label: "Stagione",
                    tint: TwoWatchTheme.brandWarm,
                    isActive: false
                ) {
                    withUserID { uid in
                        Task { await viewModel.markSeriesSeasonWatched(userID: uid) }
                    }
                }
                actionTile(
                    icon: "checkmark.seal.fill",
                    label: "Completata",
                    tint: TwoWatchTheme.success,
                    isActive: personalState?.isCompleted == true
                ) {
                    withUserID { uid in
                        Task { await viewModel.markSeriesCompleted(userID: uid) }
                    }
                }
                actionTile(
                    icon: "arrow.counterclockwise",
                    label: personalState?.isInRewatch == true ? "Rewatch on" : "Rewatch",
                    tint: TwoWatchTheme.brandWarm,
                    isActive: personalState?.isInRewatch == true
                ) {
                    withUserID { uid in
                        Task {
                            await viewModel.setRewatchIntent(userID: uid, isIncluded: !(personalState?.isInRewatch ?? false))
                        }
                    }
                }
            }
        }
    }

    private func actionTile(
        icon: String,
        label: String,
        tint: Color,
        isActive: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(isActive ? Color.black : tint)
                    .frame(width: 28, height: 28)
                    .background(isActive ? AnyShapeStyle(tint) : AnyShapeStyle(tint.opacity(0.16)), in: Circle())

                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(isActive ? tint.opacity(0.5) : TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var listActionsCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Aggiungi a una lista",
                    subtitle: String(localized: "Raccolte personali, percorsi ordinati o liste collaborative che puoi già modificare.")
                )

                if viewModel.isLoadingEditableLists {
                    HStack(spacing: 10) {
                        ProgressView()
                            .tint(TwoWatchTheme.brandPrimary)
                        Text("Carico le tue liste modificabili…")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }
                } else if viewModel.editableLists.isEmpty {
                    Text("Non hai ancora liste modificabili. Creane una qui sotto e il titolo verrà aggiunto subito.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                } else {
                    ForEach(viewModel.editableLists.prefix(6)) { list in
                        Button {
                            withUserID { uid in
                                Task { await viewModel.addTitleToList(userID: uid, listID: list.id) }
                            }
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: list.kind.symbolName)
                                    .font(.headline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.accent)
                                    .frame(width: 28)

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(list.title)
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                    Text("\(list.visibility.label) • \(list.itemCount) titoli")
                                        .font(.caption)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                }

                                Spacer(minLength: 8)

                                Image(systemName: "plus.circle.fill")
                                    .font(.headline)
                                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                            }
                            .padding(14)
                            .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private var quickCreateCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Crea lista e aggiungi",
                    subtitle: String(localized: "Flow rapido per partire da questo titolo e rifinire poi la lista con calma.")
                )

                VStack(alignment: .leading, spacing: 10) {
                    TextField("Nome lista", text: $quickListName)
                        .textInputAutocapitalization(.words)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    Picker("Visibilità", selection: $quickListVisibility) {
                        ForEach(UserListVisibility.allCases) { visibility in
                            Text(visibility.label).tag(visibility)
                        }
                    }
                    .pickerStyle(.segmented)

                    Picker("Tipo", selection: $quickListKind) {
                        ForEach(UserListKind.allCases) { kind in
                            Text(kind.label).tag(kind)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                Button(viewModel.isCreatingQuickList ? "Creo…" : "Crea e aggiungi") {
                    guard !viewModel.isCreatingQuickList else { return }
                    withUserID { uid in
                        Task {
                            await viewModel.createQuickList(
                                userID: uid,
                                owner: session.appUser,
                                name: quickListName,
                                visibility: quickListVisibility,
                                kind: quickListKind
                            )
                            if viewModel.errorMessage == nil {
                                quickListName = ""
                            }
                        }
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(viewModel.isCreatingQuickList)
            }
        }
    }

    private var statusTint: Color {
        guard let personalState else { return TwoWatchTheme.brandWarm }
        switch personalState.statusValue {
        case MoviePersonalStatus.rated.rawValue, SeriesPersonalStatus.rated.rawValue:
            return TwoWatchTheme.success
        case MoviePersonalStatus.seenUnrated.rawValue, SeriesPersonalStatus.completedUnrated.rawValue:
            return TwoWatchTheme.warning
        case SeriesPersonalStatus.inProgress.rawValue:
            return TwoWatchTheme.accent
        default:
            return TwoWatchTheme.brandWarm
        }
    }

    private func withUserID(_ action: (String) -> Void) {
        guard let uid = session.firebaseUser?.uid else {
            dismiss()
            onRequireAuth()
            return
        }
        action(uid)
    }
}

