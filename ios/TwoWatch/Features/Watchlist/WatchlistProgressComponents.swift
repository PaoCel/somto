import SwiftUI

// Avanzamento delle serie in libreria: disclosure stagioni/episodi, card di
// stagione, riga episodio, toggle. Estratti da WatchlistView.swift.

struct WatchlistSeriesProgressDisclosure: View {
    let state: TitlePersonalState
    let session: SessionStore
    @Bindable var viewModel: WatchlistViewModel
    let container: AppContainer
    let onToggleWatchlist: () -> Void
    let onAddToList: () -> Void

    @State private var isExpanded = false
    @State private var expandedSeasonNumbers: Set<Int> = []
    @State private var seasons: [TitleSeason] = []
    @State private var isLoadingSeasons = false
    @State private var seasonLoadFailed = false

    // Override ottimistico: la spunta si aggiorna all'istante; il valore reale
    // arriva dal reload in background e poi l'override viene azzerato.
    @State private var optimisticWatchedCount: Int?

    private var title: Title? {
        state.title
    }

    private var watchedEpisodeCount: Int {
        optimisticWatchedCount ?? (state.seriesProgress?.episodesWatchedCount ?? 0)
    }

    private var sortedSeasons: [TitleSeason] {
        seasons.sorted { $0.seasonNumber < $1.seasonNumber }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) {
                        isExpanded.toggle()
                    }
                    if isExpanded {
                        loadSeasonsIfNeeded()
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: isExpanded ? "chevron.down.circle.fill" : "chevron.right.circle.fill")
                            .font(.subheadline.weight(.bold))
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Stagioni ed episodi")
                                .font(.subheadline.weight(.bold))
                            Text("Correggi il progresso senza uscire dalla watchlist.")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isExpanded ? "Chiudi stagioni ed episodi" : "Apri stagioni ed episodi")

                WatchlistIconActionButton(
                    systemName: "bookmark.slash",
                    accessibilityLabel: "Rimuovi dalla watchlist",
                    tint: TwoWatchTheme.brandWarm,
                    fillOpacity: 0.14,
                    action: onToggleWatchlist
                )
                .frame(width: 66)

                WatchlistIconActionButton(
                    systemName: "rectangle.stack.badge.plus",
                    accessibilityLabel: "Aggiungi a una lista",
                    tint: TwoWatchTheme.accent,
                    fillOpacity: 0.14,
                    action: onAddToList
                )
                .frame(width: 66)
            }

            if isExpanded {
                VStack(alignment: .leading, spacing: 12) {
                    if isLoadingSeasons {
                        HStack(spacing: 10) {
                            ProgressView()
                                .tint(TwoWatchTheme.accent)
                            Text("Sto caricando stagioni ed episodi…")
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                        .padding(.horizontal, 4)
                    } else if !sortedSeasons.isEmpty {
                        if state.isInProgressSeries {
                            Text("Puoi segnare episodio o stagione come visti, oppure tornare indietro con “Non visto”.")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .padding(.horizontal, 4)
                        }

                        ForEach(sortedSeasons) { season in
                            WatchlistSeasonProgressCard(
                                season: season,
                                isExpanded: expandedSeasonNumbers.contains(season.seasonNumber),
                                isWatched: isSeasonWatched(season),
                                watchedEpisodeCount: watchedEpisodes(in: season),
                                onToggleExpanded: {
                                    withAnimation(.spring(response: 0.28, dampingFraction: 0.84)) {
                                        if expandedSeasonNumbers.contains(season.seasonNumber) {
                                            expandedSeasonNumbers.remove(season.seasonNumber)
                                        } else {
                                            expandedSeasonNumbers.insert(season.seasonNumber)
                                        }
                                    }
                                },
                                onToggleSeasonWatched: { watched in
                                    updateSeason(season, watched: watched)
                                },
                                episodeRows: {
                                    // Guardia anti-crash: con 0 episodi (stagione annunciata / dati TMDB
                                    // incompleti) "1 ... 0" è un Range invalido e fa crashare la view.
                                    if season.episodeCount > 0 {
                                        ForEach(1 ... season.episodeCount, id: \.self) { episodeNumber in
                                            WatchlistEpisodeProgressRow(
                                                episodeNumber: episodeNumber,
                                                isWatched: isEpisodeWatched(season: season, episodeNumber: episodeNumber),
                                                onToggleWatched: { watched in
                                                    updateEpisode(in: season, episodeNumber: episodeNumber, watched: watched)
                                                }
                                            )
                                        }
                                    }
                                }
                            )
                        }

                    } else {
                        EmptyStateView(
                            title: seasonLoadFailed ? "Stagioni non caricate" : "Stagioni non disponibili",
                            message: seasonLoadFailed
                                ? "Per questa serie il dettaglio episodi non e disponibile al momento."
                                : "Non abbiamo ancora un elenco episodi per questa serie.",
                            systemImage: "list.bullet.rectangle"
                        )
                    }
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    private func loadSeasonsIfNeeded() {
        guard seasons.isEmpty, !isLoadingSeasons, let title else { return }

        isLoadingSeasons = true
        seasonLoadFailed = false

        Task {
            do {
                let loadedSeasons = try await container.titleRepository.fetchSeasonMetadata(for: title)
                await MainActor.run {
                    seasons = loadedSeasons
                    seasonLoadFailed = false
                    isLoadingSeasons = false
                }
            } catch {
                await MainActor.run {
                    seasonLoadFailed = true
                    isLoadingSeasons = false
                }
            }
        }
    }

    private func watchedEpisodes(in season: TitleSeason) -> Int {
        let before = sortedSeasons
            .filter { $0.seasonNumber < season.seasonNumber }
            .reduce(0) { $0 + max(0, $1.episodeCount) }
        return max(0, min(max(0, season.episodeCount), watchedEpisodeCount - before))
    }

    private func isSeasonWatched(_ season: TitleSeason) -> Bool {
        guard season.episodeCount > 0 else { return false }
        return watchedEpisodes(in: season) >= season.episodeCount
    }

    private func isEpisodeWatched(season: TitleSeason, episodeNumber: Int) -> Bool {
        guard let linearIndex = linearEpisodeIndex(season: season, episodeNumber: episodeNumber) else {
            return false
        }
        return watchedEpisodeCount >= linearIndex
    }

    private func linearEpisodeIndex(season: TitleSeason, episodeNumber: Int) -> Int? {
        guard episodeNumber > 0, season.episodeCount > 0, episodeNumber <= season.episodeCount else { return nil }
        let before = sortedSeasons
            .filter { $0.seasonNumber < season.seasonNumber }
            .reduce(0) { $0 + max(0, $1.episodeCount) }
        return before + episodeNumber
    }

    private func completedSeasonCount(for watchedEpisodesCount: Int) -> Int {
        var remaining = max(0, watchedEpisodesCount)
        var completed = 0

        for season in sortedSeasons {
            let seasonEpisodes = max(0, season.episodeCount)
            guard seasonEpisodes > 0 else { continue }
            if remaining >= seasonEpisodes {
                completed += 1
                remaining -= seasonEpisodes
            } else {
                break
            }
        }

        return completed
    }

    private func lastWatchedMarker(for watchedEpisodesCount: Int) -> (season: Int?, episode: Int?) {
        guard watchedEpisodesCount > 0 else { return (nil, nil) }

        var remaining = watchedEpisodesCount
        for season in sortedSeasons {
            let seasonEpisodes = max(0, season.episodeCount)
            guard seasonEpisodes > 0 else { continue }
            if remaining <= seasonEpisodes {
                return (season.seasonNumber, remaining)
            }
            remaining -= seasonEpisodes
        }

        if let lastSeason = sortedSeasons.last, lastSeason.episodeCount > 0 {
            return (lastSeason.seasonNumber, lastSeason.episodeCount)
        }

        return (nil, nil)
    }

    private func updateEpisode(in season: TitleSeason, episodeNumber: Int, watched: Bool) {
        guard let uid = session.firebaseUser?.uid,
              let linearIndex = linearEpisodeIndex(season: season, episodeNumber: episodeNumber) else { return }

        let nextWatchedCount = watched ? linearIndex : max(0, linearIndex - 1)
        let completedSeasons = completedSeasonCount(for: nextWatchedCount)
        let marker = lastWatchedMarker(for: nextWatchedCount)

        let previousCount = watchedEpisodeCount
        optimisticWatchedCount = nextWatchedCount
        Task {
            let nextState = await viewModel.setSeriesEpisodeProgress(
                userID: uid,
                state: state,
                watchedEpisodesCount: nextWatchedCount,
                completedSeasonsCount: completedSeasons,
                lastWatchedSeasonNumber: marker.season,
                lastWatchedEpisodeNumber: marker.episode
            )
            optimisticWatchedCount = nil
            guard watched, let title = state.title, let nextState else { return }
            container.episodeSeenCoordinator.presentAfterAtomicAdvance(
                title: title,
                previousEpisodeCount: previousCount,
                updatedProgress: nextState.seriesProgress,
                completesSeries: nextState.isCompleted,
                hasTitleRating: nextState.hasTitleRating,
                source: "watchlist_episode_toggle"
            )
        }
    }

    private func updateSeason(_ season: TitleSeason, watched: Bool) {
        guard let uid = session.firebaseUser?.uid else { return }

        let before = sortedSeasons
            .filter { $0.seasonNumber < season.seasonNumber }
            .reduce(0) { $0 + max(0, $1.episodeCount) }
        let targetWatchedCount = watched ? before + max(0, season.episodeCount) : before
        let completedSeasons = completedSeasonCount(for: targetWatchedCount)
        let marker = lastWatchedMarker(for: targetWatchedCount)

        optimisticWatchedCount = targetWatchedCount
        Task {
            await viewModel.setSeriesSeasonProgress(
                userID: uid,
                state: state,
                watchedEpisodesCount: targetWatchedCount,
                completedSeasonsCount: completedSeasons,
                lastWatchedSeasonNumber: marker.season,
                lastWatchedEpisodeNumber: marker.episode
            )
            optimisticWatchedCount = nil
        }
    }
}

/// Card "novità": serie completata con nuovi contenuti disponibili. `internal`
/// perché riusata dal launchpad della Home ("Novità per te").

struct WatchlistSeasonProgressCard<EpisodeRows: View>: View {
    let season: TitleSeason
    let isExpanded: Bool
    let isWatched: Bool
    let watchedEpisodeCount: Int
    let onToggleExpanded: () -> Void
    let onToggleSeasonWatched: (Bool) -> Void
    @ViewBuilder let episodeRows: () -> EpisodeRows

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Button(action: onToggleExpanded) {
                    HStack(spacing: 10) {
                        Image(systemName: isExpanded ? "chevron.down.circle.fill" : "chevron.right.circle.fill")
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textMuted)

                        VStack(alignment: .leading, spacing: 3) {
                            Text({
                            if let name = season.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
                                return name
                            }
                            return "Stagione \(season.seasonNumber)"
                        }())
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)

                            Text(season.episodeCount > 0 ? "\(watchedEpisodeCount)/\(season.episodeCount) episodi visti" : "Episodi non disponibili")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }

                        Spacer(minLength: 0)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel({
                    // Stessa logica del Text sopra: usa il nome della stagione se non vuoto
                    let trimmed = season.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let name = trimmed.isEmpty ? "Stagione \(season.seasonNumber)" : trimmed
                    return isExpanded ? "Chiudi \(name)" : "Apri \(name)"
                }())

                WatchlistProgressToggleButton(
                    title: isWatched ? "Vista" : String(localized: "Non vista"),
                    isActive: isWatched,
                    activeTint: TwoWatchTheme.success,
                    action: { onToggleSeasonWatched(!isWatched) }
                )
                // Etichetta per il toggle stagione vista/non vista
                .accessibilityLabel(isWatched
                    ? "Segna stagione come non vista"
                    : "Segna stagione come vista")
            }

            if isExpanded, season.episodeCount > 0 {
                VStack(spacing: 10) {
                    episodeRows()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(14)
        .background(TwoWatchTheme.panelStrong, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

struct WatchlistEpisodeProgressRow: View {
    let episodeNumber: Int
    let isWatched: Bool
    let onToggleWatched: (Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Episodio \(episodeNumber)")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text(isWatched ? "Segnato come visto" : "Ancora da vedere")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }

            Spacer(minLength: 0)

            WatchlistProgressToggleButton(
                title: isWatched ? "Visto" : String(localized: "Non visto"),
                isActive: isWatched,
                activeTint: TwoWatchTheme.accent,
                action: { onToggleWatched(!isWatched) }
            )
            // Etichetta esplicita per il toggle episodio
            .accessibilityLabel(isWatched
                ? "Episodio \(episodeNumber) visto, tocca per segnare come non visto"
                : "Episodio \(episodeNumber) non visto, tocca per segnare come visto")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

struct WatchlistProgressToggleButton: View {
    let title: String
    let isActive: Bool
    let activeTint: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.caption.weight(.bold))
                .foregroundStyle(isActive ? .white : TwoWatchTheme.textSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    isActive ? activeTint : TwoWatchTheme.panel,
                    in: Capsule()
                )
                .overlay(
                    Capsule()
                        .stroke(isActive ? Color.clear : TwoWatchTheme.border, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}
