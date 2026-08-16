import SwiftUI

// Personaggi preferiti: sezione, avatar e lista completa. Estratti da
// TitleDetailSections.swift.

struct TitleCharacterSection: View {
    let title: Title
    let container: AppContainer
    let session: SessionStore
    let personalState: TitlePersonalState?

    @State private var aggregate: TitleCharacterAggregate?
    @State private var candidates: [CharacterCandidate] = []
    @State private var myPicks: MyCharacterPicks?
    @State private var isFullListPresented = false

    private var isUnlocked: Bool {
        personalState?.isCompleted == true
    }

    /// Mostra il teaser bloccato solo se l'utente ha già iniziato il
    /// titolo: niente ingombro su titoli mai aperti/appena aggiunti.
    private var hasStarted: Bool {
        switch title.type {
        case .movie:
            return personalState?.movieStatus != nil && personalState?.movieStatus != .unseen
        case .tv:
            return personalState?.seriesStatus != nil && personalState?.seriesStatus != .notStarted
        }
    }

    /// Serie: preferisce i pick per-episodio (`series`); se nessuno ha
    /// ancora votato episodio per episodio ma esistono pick diretti a
    /// livello titolo, usa quelli. Film: solo `direct` (non esiste livello
    /// episodio).
    private var communityBucket: CharacterVoteBucket? {
        guard let aggregate else { return nil }
        if aggregate.series.totalUsers > 0 { return aggregate.series }
        if aggregate.direct.totalUsers > 0 { return aggregate.direct }
        return nil
    }

    private var showsPercentages: Bool {
        (communityBucket?.totalUsers ?? 0) >= 3
    }

    private var rankedEntries: [(candidate: CharacterCandidate, count: Int)] {
        guard let communityBucket else { return [] }
        let candidateByID = Dictionary(candidates.map { ($0.personId, $0) }, uniquingKeysWith: { first, _ in first })
        return communityBucket.rankedCounts.map { entry in
            let candidate = candidateByID[entry.personId] ?? CharacterCandidate(
                personId: entry.personId,
                name: "Personaggio",
                character: nil,
                profileURL: nil,
                order: 0,
                isGuest: false
            )
            return (candidate, entry.count)
        }
    }

    var body: some View {
        Group {
            if isUnlocked {
                TitleCollapsibleSection(
                    title: "Personaggi preferiti",
                    subtitle: communityBucket.map { String(localized: "\($0.totalUsers) persone") },
                    accessibilityHintExpanded: String(localized: "Tocca per vedere i personaggi più scelti")
                ) {
                    unlockedContent
                }
                .task(id: session.firebaseUser?.uid) { await load() }
            } else if hasStarted, session.firebaseUser?.uid != nil {
                lockedTeaser
            }
        }
        .sheet(isPresented: $isFullListPresented) {
            TitleCharacterFullListSheet(
                entries: rankedEntries,
                totalUsers: communityBucket?.totalUsers ?? 0,
                showsPercentages: showsPercentages
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    @ViewBuilder
    private var unlockedContent: some View {
        if let communityBucket, communityBucket.totalUsers > 0, !rankedEntries.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                VStack(spacing: 10) {
                    ForEach(rankedEntries.prefix(3), id: \.candidate.id) { entry in
                        characterRow(entry)
                    }
                }

                if let myPicks, let topCharacter = myPicks.topCharacter ?? candidateName(for: myPicks.topPersonId) {
                    HStack(spacing: 6) {
                        Image(systemName: "star.fill")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                        Text("Il tuo preferito: \(topCharacter)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                }

                if rankedEntries.count > 3 {
                    Button {
                        isFullListPresented = true
                    } label: {
                        Text("Vedi tutti")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.accent)
                    }
                    .buttonStyle(.plain)
                }

                if communityBucket.totalUsers > 0 {
                    Text("Si possono scegliere fino a 3 personaggi: il totale delle percentuali può superare il 100%.")
                        .font(.caption2)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
        } else {
            Text("Ancora nessun pick su questo titolo. Guarda un episodio per essere il primo.")
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
    }

    private var lockedTeaser: some View {
        TitleSectionCard {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "lock.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Personaggi preferiti")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text(
                        title.type == .movie
                            ? "Risultati visibili dopo la visione."
                            : "Risultati visibili a fine serie, per non anticipare chi compare."
                    )
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                }

                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func characterRow(_ entry: (candidate: CharacterCandidate, count: Int)) -> some View {
        let fraction = communityBucket.map { Double(entry.count) / Double(max($0.totalUsers, 1)) } ?? 0

        return HStack(spacing: 10) {
            characterAvatar(entry.candidate)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(entry.candidate.name)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)
                    if let character = entry.candidate.character, !character.isEmpty {
                        Text(character)
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if showsPercentages {
                        Text("\(Int((fraction * 100).rounded()))%")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .monospacedDigit()
                    }
                }

                if showsPercentages {
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(TwoWatchTheme.panel)
                            Capsule()
                                .fill(TwoWatchTheme.brandGradient)
                                .frame(width: geo.size.width * max(0, min(1, fraction)))
                        }
                    }
                    .frame(height: 6)
                }
            }
        }
    }

    private func candidateName(for personId: String?) -> String? {
        guard let personId else { return nil }
        return candidates.first(where: { $0.personId == personId })?.name
    }

    private func load() async {
        guard session.firebaseUser?.uid != nil else {
            aggregate = nil
            myPicks = nil
            return
        }
        async let aggregateTask = container.titleRepository.fetchTitleCharacterAggregate(titleID: title.id)
        async let candidatesTask = container.titleRepository.fetchTitleCharacterCandidates(title: title)
        aggregate = try? await aggregateTask
        candidates = (try? await candidatesTask) ?? []
        if let uid = session.firebaseUser?.uid {
            myPicks = try? await container.titleRepository.fetchMyCharacterPicks(titleID: title.id, uid: uid)
        }
    }
}

// Costruisce una View (CachedAsyncImage), il cui init e' isolato al main
// actor: la funzione va dichiarata di conseguenza.
@MainActor
func characterAvatar(_ candidate: CharacterCandidate) -> some View {
    ZStack {
        Circle().fill(TwoWatchTheme.panelStrong)
        if let url = candidate.profileURL {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                default:
                    Text(String(candidate.name.prefix(1)).uppercased())
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
            }
        } else {
            Text(String(candidate.name.prefix(1)).uppercased())
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
    }
    .frame(width: 40, height: 40)
    .clipShape(Circle())
    .overlay(Circle().stroke(TwoWatchTheme.border, lineWidth: 1))
}

/// "Vedi tutti": classifica completa in un foglio, non nella card compatta
/// (vincolo di prodotto — la card resta al massimo top 3).
struct TitleCharacterFullListSheet: View {
    let entries: [(candidate: CharacterCandidate, count: Int)]
    let totalUsers: Int
    let showsPercentages: Bool

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 12) {
                    ForEach(Array(entries.enumerated()), id: \.element.candidate.id) { index, entry in
                        HStack(spacing: 12) {
                            Text("\(index + 1)")
                                .font(.subheadline.weight(.heavy))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                                .frame(width: 20)
                                .monospacedDigit()

                            characterAvatar(entry.candidate)

                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.candidate.name)
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textPrimary)
                                if let character = entry.candidate.character, !character.isEmpty {
                                    Text(character)
                                        .font(.caption)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                }
                            }

                            Spacer(minLength: 8)

                            if showsPercentages {
                                let fraction = Double(entry.count) / Double(max(totalUsers, 1))
                                Text("\(Int((fraction * 100).rounded()))%")
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                    .monospacedDigit()
                            }
                        }
                        .padding(12)
                        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }

                    if totalUsers > 0 {
                        Text("Si possono scegliere fino a 3 personaggi: il totale delle percentuali può superare il 100%.")
                            .font(.caption2)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(20)
            }
            .background(TwoWatchTheme.background.ignoresSafeArea())
            .navigationTitle("Personaggi preferiti")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
            }
        }
    }
}
