import SwiftUI

// Stagioni ed episodi di una serie nella scheda titolo. Estratta da
// TitleDetailSections.swift.

struct TitleSeriesSeasonsSection: View {
    let title: Title
    let container: AppContainer
    let seasons: [TitleSeason]
    let isLoadingSeasons: Bool
    let personalState: TitlePersonalState?
    let viewModel: TitleDetailViewModel
    let isAuthenticated: Bool
    let isCompactWidth: Bool
    let onSelectSeasonRating: (Int, Double) -> Void
    /// Segna il progresso fino all'episodio dato (watermark). Passa `episode-1`
    /// per lo step back / un-see.
    let onSelectEpisodeProgress: (Int, Int) -> Void
    /// Un-see del primo episodio in assoluto: azzera il progresso serie.
    /// Il contatore lineare non ha un "episodio 0" da rappresentare (il clamp
    /// a 1 di seriesProgressPayload rendeva E1 impossibile da togliere).
    let onMarkSeriesUnstarted: () -> Void
    let onMarkSeasonCompleted: (Int) -> Void
    let onOpenEpisodeRating: (Int, Int) -> Void
    let onOpenEpisodeComments: (Int, Int) -> Void
    let onDeleteEpisodeRating: (Int, Int) -> Void
    let onRequestAuth: () -> Void

    @State private var selectedSeasonNumber: Int?
    @State private var episodes: [TitleEpisode] = []
    @State private var isLoadingEpisodes = false
    @State private var loadedKey: String?
    @State private var showsSeasonRating = false
    /// Bucket personaggi per episodio ("{stagione}_{episodio}"). Una read sola
    /// per titolo: alimenta sia la classifica di stagione sia quella dei
    /// singoli episodi. I dati esistevano gia', non li mostrava nessuno.
    @State private var characterBuckets: [String: CharacterVoteBucket] = [:]
    @State private var loadedCharacterBucketsForTitleID: String?

    /// personId -> nome del personaggio (o dell'interprete), dal cast gia'
    /// denormalizzato sul titolo: nessuna chiamata in piu'.
    private var castLookup: [String: String] {
        var out: [String: String] = [:]
        for member in title.castWithCharacters {
            let label = (member.character?.isEmpty == false ? member.character : member.name) ?? member.name
            out[member.personId] = label
        }
        return out
    }

    /// Somma dei bucket episodio di una stagione. La stagione non ha un
    /// aggregato server: qui sono voti totali, non utenti unici, e l'etichetta
    /// lo dice ("piu' votati negli episodi").
    private func seasonCharacterCounts(_ seasonNumber: Int) -> [(personId: String, count: Int)] {
        var merged: [String: Int] = [:]
        for (key, bucket) in characterBuckets {
            let parts = key.split(separator: "_")
            guard parts.count == 2, Int(parts[0]) == seasonNumber else { continue }
            for (personId, count) in bucket.counts where count > 0 {
                merged[personId, default: 0] += count
            }
        }
        return merged
            .map { (personId: $0.key, count: $0.value) }
            .sorted { $0.count == $1.count ? $0.personId < $1.personId : $0.count > $1.count }
    }

    private func loadCharacterBucketsIfNeeded() async {
        guard loadedCharacterBucketsForTitleID != title.id else { return }
        loadedCharacterBucketsForTitleID = title.id
        let fetched = try? await container.titleRepository.fetchEpisodeCharacterBuckets(titleID: title.id)
        characterBuckets = fetched ?? [:]
    }

    private var progressBySeason: [Int: SeasonProgressSnapshot] {
        seasonProgressMap(seasons: seasons, personalState: personalState)
    }

    /// Stagione precedente (con episodi) rispetto a quella data: bersaglio
    /// dell'un-see del primo episodio di una stagione non-prima.
    private func previousSeason(before seasonNumber: Int) -> TitleSeason? {
        seasons
            .filter { $0.seasonNumber < seasonNumber && $0.episodeCount > 0 }
            .max(by: { $0.seasonNumber < $1.seasonNumber })
    }

    /// Stagione di default: quella dell'ultimo episodio visto, altrimenti la prima.
    private var defaultSeasonNumber: Int {
        if let last = personalState?.seriesProgress?.lastWatchedSeasonNumber,
           seasons.contains(where: { $0.seasonNumber == last }) {
            return last
        }
        return seasons.first?.seasonNumber ?? 1
    }

    private var activeSeason: TitleSeason? {
        let target = selectedSeasonNumber ?? defaultSeasonNumber
        return seasons.first { $0.seasonNumber == target } ?? seasons.first
    }

    private var activeWatchedCount: Int {
        guard let season = activeSeason else { return 0 }
        return progressBySeason[season.seasonNumber]?.watchedCount ?? 0
    }

    /// Numero di righe da mostrare: il catalogo Somto è autoritativo per la
    /// matematica del progresso; TMDB riempie i nomi. Se il catalogo non ha il
    /// conteggio, si usa il massimo numero episodio da TMDB.
    private var episodeCount: Int {
        guard let season = activeSeason else { return 0 }
        if season.episodeCount > 0 { return season.episodeCount }
        return episodes.map(\.number).max() ?? 0
    }

    private var episodesByNumber: [Int: TitleEpisode] {
        Dictionary(episodes.map { ($0.number, $0) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Episodi",
                    subtitle: String(localized: "Scegli la stagione e segna cosa hai visto. Voto e commenti sono a portata di riga.")
                )

                if seasons.isEmpty && isLoadingSeasons {
                    TitleSeasonsLoadingSkeleton()
                } else if seasons.isEmpty {
                    SectionEmptyStateView(
                        title: "Stagioni non disponibili",
                        message: "I dati per questa serie non sono ancora completi.",
                        systemImage: "square.stack.3d.up.slash"
                    )
                } else if let season = activeSeason {
                    seasonSelector(season: season)
                    seasonProgressBar
                    seasonRatingRow(season: season)
                    seasonCharacterStrip(season: season)
                        .task(id: title.id) { await loadCharacterBucketsIfNeeded() }
                    episodeList(season: season)
                }
            }
        }
        .task(id: activeSeason?.seasonNumber) {
            await loadEpisodes()
        }
    }

    // MARK: - Season progress bar

    @ViewBuilder
    private var seasonProgressBar: some View {
        if episodeCount > 0 {
            let fraction = min(1, max(0, Double(activeWatchedCount) / Double(episodeCount)))
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(TwoWatchTheme.panelStrong)
                    if fraction > 0 {
                        Capsule()
                            .fill(LinearGradient(
                                colors: [TwoWatchTheme.brandPrimary, TwoWatchTheme.brandSecondary],
                                startPoint: .leading,
                                endPoint: .trailing
                            ))
                            .frame(width: max(6, geo.size.width * fraction))
                    }
                }
            }
            .frame(height: 4)
            .padding(.top, 2)
            .accessibilityHidden(true)
        }
    }

    // MARK: - Season selector

    @ViewBuilder
    private func seasonSelector(season: TitleSeason) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Menu {
                ForEach(seasons) { option in
                    Button {
                        selectedSeasonNumber = option.seasonNumber
                    } label: {
                        if option.seasonNumber == season.seasonNumber {
                            Label(seasonMenuLabel(option), systemImage: "checkmark")
                        } else {
                            Text(seasonMenuLabel(option))
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(seasonTitle(season))
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                    Image(systemName: "chevron.down")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(TwoWatchTheme.panelStrong, in: Capsule())
                .overlay(Capsule().stroke(TwoWatchTheme.border, lineWidth: 1))
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Stagione \(season.seasonNumber). Tocca per cambiare stagione.")

            if TitleReleaseFreshness.isRecent(airDate: season.airDate) {
                NewReleaseBadge()
            }

            Spacer(minLength: 0)

            if episodeCount > 0 {
                Text("\(activeWatchedCount)/\(episodeCount) visti")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .monospacedDigit()
            }
        }
    }

    private func seasonTitle(_ season: TitleSeason) -> String {
        if let name = season.name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty, season.seasonNumber > 0 {
            return name
        }
        return "Stagione \(season.seasonNumber)"
    }

    private func seasonMenuLabel(_ season: TitleSeason) -> String {
        let base = "Stagione \(season.seasonNumber)"
        if season.episodeCount > 0 { return "\(base) · \(season.episodeCount) ep" }
        return base
    }

    // MARK: - Season rating (secondary)

    @ViewBuilder
    private func seasonRatingRow(season: TitleSeason) -> some View {
        let seasonRating = viewModel.rating(level: "season", season: season.seasonNumber)?.rating

        if isAuthenticated {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { showsSeasonRating.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: seasonRating != nil ? "star.fill" : "star")
                            .font(.system(size: 12, weight: .bold))
                        Text(seasonRating != nil ? "Voto stagione: \(RatingDisplayFormat.halfStep(seasonRating))" : "Vota la stagione")
                            .font(.caption.weight(.semibold))
                        Image(systemName: showsSeasonRating ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10, weight: .bold))
                    }
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(seasonRating != nil ? String(localized: "Voto stagione \(RatingDisplayFormat.halfStep(seasonRating)). Tocca per modificare.") : "Vota la stagione \(season.seasonNumber)")

                if showsSeasonRating {
                    SomtoStarRatingRow(value: seasonRating, showsLabel: false) { value in
                        onSelectSeasonRating(season.seasonNumber, value)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    // MARK: - Episode list

    /// Classifica personaggi della stagione. Stesso cancello del titolo: si
    /// vede solo se la stagione e' stata guardata, per non anticipare chi c'e'.
    @ViewBuilder
    private func seasonCharacterStrip(season: TitleSeason) -> some View {
        let watched = progressBySeason[season.seasonNumber]?.watchedCount ?? 0
        let total = season.episodeCount
        let ranked = Array(seasonCharacterCounts(season.seasonNumber).prefix(3))
        if total > 0, watched >= total, !ranked.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Personaggi piu' votati della stagione")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                ForEach(Array(ranked.enumerated()), id: \.offset) { index, entry in
                    HStack(spacing: 8) {
                        Text("\(index + 1)")
                            .font(.caption2.weight(.black))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                            .frame(width: 14)
                        Text(castLookup[entry.personId] ?? entry.personId)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text(entry.count == 1 ? "1 voto" : "\(entry.count) voti")
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                    }
                }
                Text("Somma dei voti dei singoli episodi.")
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(TwoWatchTheme.panel)
            )
        }
    }

    /// Il personaggio piu' votato di un episodio, sotto la sua riga. Compare
    /// solo sugli episodi gia' visti.
    @ViewBuilder
    private func episodeCharacterLine(season: Int, episode: Int, isSeen: Bool) -> some View {
        if isSeen,
           let bucket = characterBuckets["\(season)_\(episode)"],
           let top = bucket.rankedCounts.first,
           let label = castLookup[top.personId] {
            HStack(spacing: 5) {
                Image(systemName: "star.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                Text("Piu' votato: \(label)")
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)
            }
            .padding(.leading, 14)
            .padding(.top, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func episodeList(season: TitleSeason) -> some View {
        if episodeCount > 0 {
            let seasonUnreleased = EpisodeAirDate.isFuture(season.airDate)
            VStack(spacing: 8) {
                ForEach(1 ... episodeCount, id: \.self) { number in
                    let episode = episodesByNumber[number]
                    VStack(alignment: .leading, spacing: 0) {
                    SomtoEpisodeRow(
                        number: number,
                        name: episode?.displayName() ?? "Episodio \(number)",
                        airDate: episode?.airDate,
                        isSeen: number <= activeWatchedCount,
                        isNext: number == activeWatchedCount + 1,
                        isUnreleased: seasonUnreleased || EpisodeAirDate.isFuture(episode?.airDate),
                        personalRating: viewModel.rating(level: "episode", season: season.seasonNumber, episode: number)?.rating,
                        communityRating: viewModel.average(level: "episode", season: season.seasonNumber, episode: number),
                        hasComments: false,
                        isAuthenticated: isAuthenticated,
                        onMarkSeen: { onSelectEpisodeProgress(season.seasonNumber, number) },
                        onUnsee: {
                            if number > 1 {
                                onSelectEpisodeProgress(season.seasonNumber, number - 1)
                            } else if let previous = previousSeason(before: season.seasonNumber) {
                                // "Prima di E1" = ultimo episodio della stagione
                                // precedente: il contatore lineare non ha un E0.
                                onSelectEpisodeProgress(previous.seasonNumber, max(1, previous.episodeCount))
                            } else {
                                onMarkSeriesUnstarted()
                            }
                        },
                        onOpenRating: { onOpenEpisodeRating(season.seasonNumber, number) },
                        onOpenComments: { onOpenEpisodeComments(season.seasonNumber, number) },
                        onDeleteRating: { onDeleteEpisodeRating(season.seasonNumber, number) },
                        onRequestAuth: onRequestAuth
                    )
                    episodeCharacterLine(
                        season: season.seasonNumber,
                        episode: number,
                        isSeen: number <= activeWatchedCount
                    )
                    }
                }

                if isLoadingEpisodes {
                    ProgressView()
                        .tint(TwoWatchTheme.brandPrimary)
                        .padding(.vertical, 6)
                }

                // Stagione non ancora uscita: niente "segna completa" (caso
                // Reacher S4 annunciata su TMDB prima della messa in onda).
                if !EpisodeAirDate.isFuture(season.airDate) {
                Button {
                    guard !seasonIsCompleted(season) else { return }
                    if isAuthenticated { onMarkSeasonCompleted(season.seasonNumber) } else { onRequestAuth() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: seasonIsCompleted(season) ? "checkmark.circle.fill" : "checklist")
                            .font(.system(size: 12, weight: .bold))
                        Text(seasonIsCompleted(season) ? "Stagione completata" : "Segna stagione completa")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(seasonIsCompleted(season) ? TwoWatchTheme.success : TwoWatchTheme.textSecondary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 34)
                    .background(
                        Capsule().fill(seasonIsCompleted(season) ? TwoWatchTheme.success.opacity(0.12) : TwoWatchTheme.panel)
                    )
                    .overlay(
                        Capsule().stroke(seasonIsCompleted(season) ? TwoWatchTheme.success.opacity(0.4) : TwoWatchTheme.border, lineWidth: 1)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(seasonIsCompleted(season))
                .padding(.top, 4)
                }
            }
        } else {
            SectionEmptyStateView(
                title: "Episodi non disponibili",
                message: "Non abbiamo ancora un elenco episodi per questa stagione.",
                systemImage: "list.bullet.rectangle"
            )
        }
    }

    private func seasonIsCompleted(_ season: TitleSeason) -> Bool {
        progressBySeason[season.seasonNumber]?.isCompleted ?? false
    }

    // MARK: - TMDB fetch

    private func loadEpisodes() async {
        guard let season = activeSeason else {
            episodes = []
            return
        }
        guard let tmdbID = title.metadata.tmdbId, tmdbID > 0 else {
            // Nessun tmdbId: righe solo-numero (fallback), niente nomi/date.
            episodes = []
            loadedKey = nil
            return
        }
        let key = "\(tmdbID)_\(season.seasonNumber)"
        if loadedKey == key { return }

        episodes = []
        isLoadingEpisodes = true
        defer { isLoadingEpisodes = false }

        let fetched = (try? await container.titleRepository.fetchTMDBSeasonEpisodes(
            tmdbID: tmdbID,
            season: season.seasonNumber
        )) ?? []

        // Guardia anti-race: se nel frattempo l'utente ha cambiato stagione,
        // scarta il risultato ormai obsoleto.
        guard activeSeason?.seasonNumber == season.seasonNumber else { return }
        episodes = fetched
        loadedKey = key
    }
}
