import SwiftUI

// Dove si guarda, cast e crediti, piu' i calcoli di avanzamento serie usati
// dalle sezioni. Estratti da TitleDetailSections.swift.

struct TitleWatchProvidersSection: View {
    let providers: TitleProviders
    let fallbackPlatformName: String?
    /// Servono a costruire la destinazione di ogni logo: link diretto se il
    /// server l'ha risolto, altrimenti ricerca nell'app della piattaforma,
    /// altrimenti la pagina "dove guardare" di sempre.
    /// Vedi `StreamingDestinationResolver`.
    var titleName: String = ""
    var tmdbId: Int?
    var isSeries: Bool = false

    /// Un logo, un indirizzo. Prima portavano tutti allo stesso posto (la
    /// pagina TMDB): toccare Netflix e finire su una pagina che ti richiede di
    /// scegliere Netflix e' un passaggio che non serviva a niente.
    private func destination(for provider: StreamingProvider) -> URL? {
        StreamingDestinationResolver.destination(
            providerName: provider.name,
            deepLinks: providers.deepLinks,
            titleName: titleName,
            tmdbId: tmdbId,
            isSeries: isSeries
        )?.url ?? providers.link
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Dove guardarlo")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            if officialProviders.isEmpty && customProviders.isEmpty {
                if let fallbackPlatformName, fallbackPlatformName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
                    TitleProviderGroup(
                        title: nil,
                        destination: destination,
                        providers: [
                            StreamingProvider(
                                id: "fallback-\(fallbackPlatformName)",
                                name: fallbackPlatformName,
                                logoURL: nil,
                                type: "fallback"
                            )
                        ]
                    )
                } else {
                    Text("Provider non trovati per \(providers.region).")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
            } else {
                if !officialProviders.isEmpty {
                    TitleProviderGroup(title: nil, destination: destination, providers: officialProviders)
                }

                if !customProviders.isEmpty {
                    TitleProviderGroup(
                        title: officialProviders.isEmpty ? nil : "Altri",
                        destination: destination,
                        providers: customProviders
                    )
                }
            }
        }
    }

    private var officialProviders: [StreamingProvider] {
        dedupe(providers.providers)
    }

    private var customProviders: [StreamingProvider] {
        dedupe(providers.customProviders)
    }

    /// Ripulisce l'elenco dei loghi.
    ///
    /// Prima si limitava a togliere i nomi identici, quindi "Apple TV" e "Apple
    /// TV Amazon Channel" erano due loghi per lo stesso servizio e Prime Video
    /// compariva in testa su titoli che Prime si limita a rivendere. Ora
    /// l'ordine e le fusioni li decide `StreamingProviderRanking`, che e' lo
    /// stesso criterio del widget.
    private func dedupe(_ items: [StreamingProvider]) -> [StreamingProvider] {
        let ordine = StreamingProviderRanking.ranked(items.map(\.name))
        var seen: Set<String> = []
        return ordine.compactMap { name in
            guard seen.insert(name.lowercased()).inserted else { return nil }
            // Si tiene la voce originale (ha logo e id): quella col nome esatto,
            // altrimenti quella che collassa su questo nome.
            return items.first { $0.name == name }
                ?? items.first { StreamingProviderRanking.baseName($0.name) == name }
        }
    }
}

/// Copy della CTA di voto: cambia tra serie e film, come sul web
/// ("Vota il personaggio che più hai preferito in questa serie/questo film").
func castVoteCtaTitle(for title: Title) -> String {
    title.type == .tv
        ? String(localized: "Vota il personaggio che più hai preferito in questa serie")
        : String(localized: "Vota il personaggio che più hai preferito in questo film")
}

struct TitleCreditsSection: View {
    let directorCredits: [TitleCreditPerson]
    let castCredits: [TitleCreditPerson]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    /// Pick community del titolo, per l'etichetta di apprezzamento.
    var characterBucket: CharacterVoteBucket? = nil
    /// Copy della CTA: cambia tra serie e film, la decide il chiamante che
    /// conosce il tipo del titolo.
    var voteCtaTitle: String = ""
    var onShowAllCast: (() -> Void)? = nil
    var onVoteCharacters: (() -> Void)? = nil

    private struct VotedLeader {
        let name: String
        let character: String
        let percent: Int
    }

    /// Anteprima del cast: prima i personaggi votati dalla community, in ordine
    /// di quota, poi il resto nell'ordine di TMDB. Il cast completo resta
    /// integrale dietro "Vedi tutto il cast" — qui si riordina, non si taglia
    /// diversamente.
    private var castPreview: (people: [TitleCreditPerson], highlights: [String: CastVoteHighlight]) {
        let highlights = voteHighlights
        guard !highlights.isEmpty else {
            return (Array(castCredits.prefix(10)), [:])
        }

        func rank(_ person: TitleCreditPerson) -> Int? {
            person.personID.flatMap { highlights[$0]?.rank }
        }

        let voted = castCredits
            .filter { rank($0) != nil }
            .sorted { (rank($0) ?? .max) < (rank($1) ?? .max) }
        let rest = castCredits.filter { rank($0) == nil }

        return (Array((voted + rest).prefix(10)), highlights)
    }

    /// Posizione e quota di ogni personaggio votato, limitate al cast che
    /// stiamo mostrando: un pick su una persona che TMDB non ci ha dato non
    /// avrebbe una card su cui comparire.
    private var voteHighlights: [String: CastVoteHighlight] {
        guard let bucket = characterBucket, bucket.totalUsers > 0 else { return [:] }

        let castIDs = Set(castCredits.compactMap(\.personID))
        let ranked = bucket.counts
            .filter { $0.value > 0 && castIDs.contains($0.key) }
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }

        var result: [String: CastVoteHighlight] = [:]
        for (index, entry) in ranked.enumerated() {
            result[entry.key] = CastVoteHighlight(
                rank: index + 1,
                percent: Int((Double(entry.value) / Double(bucket.totalUsers) * 100).rounded())
            )
        }
        return result
    }

    /// Il personaggio più scelto dalla community, con la quota di votanti.
    /// Nessuna soglia minima qui: la percentuale porta con sé il proprio
    /// contesto, ed è il dato che l'utente cerca appena vota.
    private var topVotedCharacter: VotedLeader? {
        guard let bucket = characterBucket, bucket.totalUsers > 0,
              let (personID, count) = bucket.counts.max(by: { ($0.value, $1.key) < ($1.value, $0.key) }),
              let person = castCredits.first(where: { $0.personID == personID })
        else { return nil }

        return VotedLeader(
            name: person.name,
            character: person.character ?? "",
            percent: Int((Double(count) / Double(bucket.totalUsers) * 100).rounded())
        )
    }

    var body: some View {
        TitleSectionCard {
            VStack(alignment: .leading, spacing: 14) {
                TitleSectionHeader(
                    title: "Crediti principali",
                    subtitle: String(localized: "Una lettura curata di regia e cast essenziale.")
                )

                if !directorCredits.isEmpty {
                    TitleCreditsRow(
                        title: "Regia",
                        people: directorCredits,
                        container: container,
                        session: session,
                        shell: shell
                    )
                }

                if !castCredits.isEmpty {
                    // Il più votato in chiaro, prima della riga: stava solo
                    // dentro il foglio e non lo trovava nessuno.
                    if let leader = topVotedCharacter {
                        HStack(spacing: 8) {
                            Image(systemName: "crown.fill")
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.warning)
                            Text("Il più votato")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                            Text(leader.character.isEmpty ? leader.name : leader.character)
                                .font(.caption.weight(.heavy))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                                .lineLimit(1)
                            Text("\(leader.percent)%")
                                .font(.caption.weight(.heavy))
                                .monospacedDigit()
                                .foregroundStyle(TwoWatchTheme.brandPrimary)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(TwoWatchTheme.panelStrong)
                        )
                        .accessibilityElement(children: .combine)
                    }

                    TitleCreditsRow(
                        title: "Cast",
                        subtitle: castPreview.highlights.isEmpty
                            ? nil
                            : String(localized: "In testa i più votati dalla community."),
                        people: castPreview.people,
                        container: container,
                        session: session,
                        shell: shell,
                        characterBucket: characterBucket,
                        voteHighlights: castPreview.highlights
                    )

                    // L'anteprima si ferma a 10: il resto sta dietro qui, che
                    // e' il punto che mancava — prima erano 8 e basta.
                    if castCredits.count > 10, let onShowAllCast {
                        Button("Vedi tutto il cast", action: onShowAllCast)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                    }

                    if let onVoteCharacters, !voteCtaTitle.isEmpty {
                        Button(voteCtaTitle, action: onVoteCharacters)
                            .buttonStyle(PrimaryButtonStyle())
                            .padding(.top, 4)
                    }
                }
            }
        }
    }
}

struct TitleCreditsRow: View {
    let title: String
    var subtitle: String? = nil
    let people: [TitleCreditPerson]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    var characterBucket: CharacterVoteBucket? = nil
    var voteHighlights: [String: CastVoteHighlight] = [:]

    private func appreciation(for person: TitleCreditPerson) -> CharacterAppreciation? {
        guard let personID = person.personID else { return nil }
        return CharacterAppreciation.from(bucket: characterBucket, personID: personID)
    }

    private func highlight(for person: TitleCreditPerson) -> CastVoteHighlight? {
        guard let personID = person.personID else { return nil }
        return voteHighlights[personID]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.textSecondary)

            if let subtitle {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(people) { person in
                        Group {
                            if let navigationPerson = person.navigationPerson {
                                NavigationLink {
                                    PersonTitlesView(
                                        container: container,
                                        session: session,
                                        shell: shell,
                                        person: navigationPerson
                                    )
                                } label: {
                                    TitlePersonCard(
                                        person: person,
                                        appreciation: appreciation(for: person),
                                        voteHighlight: highlight(for: person)
                                    )
                                }
                                .buttonStyle(.plain)
                            } else {
                                // Fallback: niente personID indicizzato. Cerchiamo per nome
                                // nei campi cast/directors così la card resta tappabile
                                // anche se TMDB non ha mappato il person ancora.
                                NavigationLink {
                                    PersonNameTitlesView(
                                        container: container,
                                        session: session,
                                        shell: shell,
                                        personName: person.name,
                                        avatarURL: person.avatarURL
                                    )
                                } label: {
                                    TitlePersonCard(
                                        person: person,
                                        appreciation: appreciation(for: person),
                                        voteHighlight: highlight(for: person)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

struct SeasonProgressSnapshot {
    let watchedCount: Int
    let totalEpisodes: Int
    let isCompleted: Bool
}

struct SeriesProgressPayload {
    let episodesWatchedCount: Int
    let seasonsCompletedCount: Int
    let lastWatchedSeasonNumber: Int?
    let lastWatchedEpisodeNumber: Int?
}

func seriesProgressPayload(
    seasons: [TitleSeason],
    seasonNumber: Int,
    episodeNumber: Int
) -> SeriesProgressPayload? {
    guard let seasonIndex = seasons.firstIndex(where: { $0.seasonNumber == seasonNumber }) else { return nil }
    let targetSeason = seasons[seasonIndex]
    let boundedEpisode = max(1, min(episodeNumber, max(1, targetSeason.episodeCount)))
    let watchedBefore = seasons[..<seasonIndex].reduce(into: 0) { partialResult, season in
        partialResult += max(0, season.episodeCount)
    }
    let episodesWatchedCount = watchedBefore + boundedEpisode
    let seasonsCompletedCount = seasons.reduce(into: 0) { partialResult, season in
        let seasonEpisodes = max(0, season.episodeCount)
        let seasonEnd = watchedBeforeCount(for: seasons, seasonNumber: season.seasonNumber) + seasonEpisodes
        if seasonEpisodes > 0, episodesWatchedCount >= seasonEnd {
            partialResult += 1
        }
    }
    return SeriesProgressPayload(
        episodesWatchedCount: episodesWatchedCount,
        seasonsCompletedCount: seasonsCompletedCount,
        lastWatchedSeasonNumber: seasonNumber,
        lastWatchedEpisodeNumber: boundedEpisode
    )
}

func watchedBeforeCount(for seasons: [TitleSeason], seasonNumber: Int) -> Int {
    seasons
        .filter { $0.seasonNumber < seasonNumber }
        .reduce(into: 0) { partialResult, season in
            partialResult += max(0, season.episodeCount)
        }
}

func seasonProgressMap(
    seasons: [TitleSeason],
    personalState: TitlePersonalState?
) -> [Int: SeasonProgressSnapshot] {
    let watchedEpisodes = max(0, personalState?.seriesProgress?.episodesWatchedCount ?? 0)
    var remainingEpisodes = watchedEpisodes
    var progress: [Int: SeasonProgressSnapshot] = [:]

    for season in seasons {
        let totalEpisodes = max(0, season.episodeCount)
        let watchedCount = min(totalEpisodes, max(0, remainingEpisodes))
        progress[season.seasonNumber] = SeasonProgressSnapshot(
            watchedCount: watchedCount,
            totalEpisodes: totalEpisodes,
            isCompleted: totalEpisodes > 0 && watchedCount >= totalEpisodes
        )
        remainingEpisodes = max(0, remainingEpisodes - totalEpisodes)
    }

    return progress
}
