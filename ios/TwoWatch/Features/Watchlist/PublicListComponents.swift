import SwiftUI

// Card di stato e avanzamento serie nel contesto di una lista **pubblica**:
// stesso mestiere delle controparti in libreria, ma con i permessi e i dati
// pubblici del proprietario. Estratti da WatchlistView.swift.

struct PublicListStateCard: View {
    let item: UserListItem
    let listID: String
    /// True quando l'utente è proprietario della lista: abilita il menu
    /// "Rimuovi dalla lista" anche sulle liste pubbliche (prima mancava del tutto).
    var canManage: Bool = false
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    @Bindable var viewModel: WatchlistViewModel

    var body: some View {
        if let title = item.title, let progress = item.publicProgress {
            ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 16) {
                NavigationLink {
                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                } label: {
                    HStack(alignment: .top, spacing: 14) {
                        PosterImageView(url: title.watchlistArtworkURL, width: 88, height: 132, cornerRadius: 22)

                        VStack(alignment: .leading, spacing: 10) {
                            HStack(alignment: .top, spacing: 10) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(title.name)
                                        .font(.headline.weight(.bold))
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                        .multilineTextAlignment(.leading)
                                        .fixedSize(horizontal: false, vertical: true)

                                    Text(title.watchlistGenreText(using: viewModel.genreLookup))
                                        .font(.subheadline)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                        .lineLimit(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                }

                                Spacer(minLength: 8)

                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.black))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                    .padding(.top, 4)
                                    // Nascosto quando c'è il menu gestione, per non
                                    // affollare l'angolo in alto a destra.
                                    .opacity(canManage ? 0 : 1)
                            }

                            Text(progress.statusSubtitle)
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)

                            if let progressText = progress.progressText {
                                HStack(spacing: 8) {
                                    Image(systemName: "play.circle.fill")
                                        .font(.caption.weight(.bold))
                                    Text(progressText)
                                        .font(.caption.weight(.bold))
                                }
                                .foregroundStyle(TwoWatchTheme.accent)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)

                switch title.type {
                case .movie:
                    WatchlistIconActionButton(
                        systemName: progress.isCompleted ? "arrow.uturn.backward.circle.fill" : "checkmark.circle.fill",
                        accessibilityLabel: progress.isCompleted
                            ? String(localized: "Segna come non visto in questa lista")
                            : String(localized: "Segna come visto in questa lista"),
                        tint: progress.isCompleted ? TwoWatchTheme.brandWarm : TwoWatchTheme.brandPrimary,
                        fillOpacity: progress.isCompleted ? 0.14 : 0.18
                    ) {
                        guard let uid = session.firebaseUser?.uid else { return }
                        Task {
                            await viewModel.setPublicListMovieSeen(
                                userID: uid,
                                listID: listID,
                                item: item,
                                isSeen: !progress.isCompleted
                            )
                        }
                    }

                case .tv:
                    PublicListSeriesProgressDisclosure(
                        item: item,
                        progress: progress,
                        listID: listID,
                        session: session,
                        viewModel: viewModel,
                        container: container
                    )
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TwoWatchTheme.backgroundSecondary.opacity(0.96), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(0.18), radius: 18, x: 0, y: 10)

            if canManage {
                Menu {
                    Button(role: .destructive) {
                        guard let uid = session.firebaseUser?.uid else { return }
                        Task { await viewModel.removeSelectedListItem(userID: uid, titleID: title.id) }
                    } label: {
                        Label("Rimuovi dalla lista", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.subheadline.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .frame(width: 30, height: 30)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                        .overlay(Circle().stroke(TwoWatchTheme.border, lineWidth: 1))
                }
                .padding(14)
                .accessibilityLabel("Azioni lista")
            }
            }
        }
    }
}

struct PublicListSeriesProgressDisclosure: View {
    let item: UserListItem
    let progress: PublicListItemProgress
    let listID: String
    let session: SessionStore
    @Bindable var viewModel: WatchlistViewModel
    let container: AppContainer

    @State private var isExpanded = false
    @State private var expandedSeasonNumbers: Set<Int> = []
    @State private var seasons: [TitleSeason] = []
    @State private var isLoadingSeasons = false
    @State private var seasonLoadFailed = false

    // Override ottimistico (vedi WatchlistSeriesProgressDisclosure): spunta istantanea.
    @State private var optimisticWatchedCount: Int?

    private var title: Title? {
        item.title
    }

    private var watchedEpisodeCount: Int {
        optimisticWatchedCount ?? (progress.seriesProgress?.episodesWatchedCount ?? 0)
    }

    private var sortedSeasons: [TitleSeason] {
        seasons.sorted { $0.seasonNumber < $1.seasonNumber }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
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
                        Text("Segni il progresso del percorso pubblico senza toccare quello degli altri.")
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
            .accessibilityLabel("Stagioni ed episodi")
            .accessibilityHint(isExpanded ? "Tocca per chiudere" : "Tocca per aprire")
            .accessibilityAddTraits(isExpanded ? [.isButton, .isSelected] : .isButton)

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
                        Text("Puoi marcare episodio o stagione come visti, oppure tornare indietro con “Non visto”.")
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .padding(.horizontal, 4)

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
              linearEpisodeIndex(season: season, episodeNumber: episodeNumber) != nil else { return }

        let nextWatchedCount: Int
        if watched, let linearIndex = linearEpisodeIndex(season: season, episodeNumber: episodeNumber) {
            nextWatchedCount = linearIndex
        } else if let linearIndex = linearEpisodeIndex(season: season, episodeNumber: episodeNumber) {
            nextWatchedCount = max(0, linearIndex - 1)
        } else {
            nextWatchedCount = watchedEpisodeCount
        }

        let completedSeasons = completedSeasonCount(for: nextWatchedCount)
        let marker = lastWatchedMarker(for: nextWatchedCount)

        let previousCount = watchedEpisodeCount
        optimisticWatchedCount = nextWatchedCount
        Task {
            let nextState = await viewModel.setPublicListSeriesProgress(
                userID: uid,
                listID: listID,
                item: item,
                watchedEpisodesCount: nextWatchedCount,
                completedSeasonsCount: completedSeasons,
                lastWatchedSeasonNumber: marker.season,
                lastWatchedEpisodeNumber: marker.episode
            )
            optimisticWatchedCount = nil
            guard watched, let title, let nextState else { return }
            let canonicalState = try? await container.watchlistRepository.fetchTitleState(
                userID: uid,
                title: title
            )
            container.episodeSeenCoordinator.presentAfterAtomicAdvance(
                title: title,
                previousEpisodeCount: previousCount,
                updatedProgress: nextState.seriesProgress,
                completesSeries: nextState.status == .completed,
                hasTitleRating: canonicalState?.hasTitleRating == true,
                source: "public_list_episode_toggle"
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
            await viewModel.setPublicListSeriesProgress(
                userID: uid,
                listID: listID,
                item: item,
                watchedEpisodesCount: targetWatchedCount,
                completedSeasonsCount: completedSeasons,
                lastWatchedSeasonNumber: marker.season,
                lastWatchedEpisodeNumber: marker.episode
            )
            optimisticWatchedCount = nil
        }
    }
}
