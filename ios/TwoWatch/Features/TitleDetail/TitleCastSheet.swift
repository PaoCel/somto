import SwiftUI

/// Cast completo di un titolo, in due modi.
///
/// - `.browse`: si guarda e basta. Esiste perché la scheda mostrava solo i
///   primi credits e non c'era modo di vedere gli altri.
/// - `.vote`: si scelgono fino a 3 personaggi preferiti per l'intero titolo
///   (`level: "title"`, docs/CHARACTER_VOTES_SPEC.md). Riusa
///   `CharacterPickRow`, il picker già in uso nel foglio "episodio visto":
///   nessun secondo sistema di voto.
struct TitleCastSheet: View {
    enum Mode: String, Identifiable {
        case browse
        case vote

        var id: String { rawValue }
    }

    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let title: Title
    let mode: Mode
    /// Anteprima già in mano al chiamante: si mostra subito mentre il cast
    /// completo arriva da TMDB, così il foglio non si apre vuoto.
    let initialCandidates: [CharacterCandidate]
    let communityBucket: CharacterVoteBucket?

    @Environment(\.dismiss) private var dismiss

    @State private var candidates: [CharacterCandidate]
    @State private var picks: [CharacterPick] = []
    @State private var isLoadingFullCast = true
    /// I MIEI pick, sempre visibili anche in modo sfoglia: dopo aver votato
    /// l'utente si aspetta di rivedere la sua scelta, e l'etichetta community
    /// non basta (richiede un campione minimo).
    @State private var myPickIDs: Set<String> = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        container: AppContainer,
        session: SessionStore,
        shell: AppShellStore,
        title: Title,
        mode: Mode,
        initialCandidates: [CharacterCandidate],
        communityBucket: CharacterVoteBucket?
    ) {
        self.container = container
        self.session = session
        self.shell = shell
        self.title = title
        self.mode = mode
        self.initialCandidates = initialCandidates
        self.communityBucket = communityBucket
        _candidates = State(initialValue: initialCandidates)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                TwoWatchBackground()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if mode == .vote {
                            Text("Puoi votare fino a 3 personaggi.")
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .frame(maxWidth: .infinity, alignment: .leading)

                            CharacterPickRow(
                                candidates: candidates,
                                isLoading: isLoadingFullCast && candidates.isEmpty,
                                picks: $picks
                            )
                        } else {
                            resultsSection
                            castGrid
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle(mode == .vote ? "Chi ti ha conquistato?" : "Cast completo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Chiudi") { dismiss() }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }
                if mode == .vote {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Salva") { Task { await save() } }
                            .font(.headline)
                            .disabled(isSaving)
                    }
                }
            }
            .task { await load() }
            .alert("Impossibile salvare", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("Riprova", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
        .preferredColorScheme(.dark)
    }

    /// Risultati dei voti community. Esiste perché l'etichetta di
    /// apprezzamento richiede un campione minimo: con pochi voti non compariva
    /// niente e sembrava che il voto non fosse stato registrato. Qui il dato si
    /// vede sempre, con il numero di votanti accanto così si capisce quanto
    /// pesa.
    @ViewBuilder
    private var resultsSection: some View {
        if let bucket = communityBucket, bucket.totalUsers > 0, !rankedResults.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Chi ha conquistato la community")
                    .font(.headline)
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                ForEach(rankedResults, id: \.personId) { row in
                    HStack(spacing: 10) {
                        Text(row.name)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(1)

                        if let character = row.character, !character.isEmpty {
                            Text(character)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textMuted)
                                .lineLimit(1)
                        }

                        Spacer(minLength: 8)

                        Text("\(row.percent)%")
                            .font(.subheadline.weight(.bold))
                            .monospacedDigit()
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                    }
                }

                // Con tre pick a testa la somma supera il 100%: va detto, o
                // sembra un errore di conto (spec §2.2).
                Text("Su \(bucket.totalUsers) votanti. Ognuno può sceglierne fino a 3, quindi la somma supera il 100%.")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 4)
        }
    }

    private struct ResultRow {
        let personId: String
        let name: String
        let character: String?
        let percent: Int
    }

    /// Top 5 per numero di utenti che li hanno scelti. I nomi arrivano dai
    /// candidati; chi non è più nel cast (rinomine TMDB) resta fuori invece di
    /// comparire come id nudo.
    private var rankedResults: [ResultRow] {
        guard let bucket = communityBucket, bucket.totalUsers > 0 else { return [] }
        let byID = Dictionary(candidates.map { ($0.personId, $0) }, uniquingKeysWith: { first, _ in first })

        return bucket.counts
            .sorted { ($0.value, $1.key) > ($1.value, $0.key) }
            .prefix(5)
            .compactMap { personID, count -> ResultRow? in
                guard let candidate = byID[personID] else { return nil }
                let percent = Int((Double(count) / Double(bucket.totalUsers) * 100).rounded())
                return ResultRow(
                    personId: personID,
                    name: candidate.name,
                    character: candidate.character,
                    percent: percent
                )
            }
    }

    private var castGrid: some View {
        LazyVGrid(columns: [
            GridItem(.flexible(), spacing: 14),
            GridItem(.flexible(), spacing: 14),
            GridItem(.flexible(), spacing: 14)
        ], spacing: 18) {
            ForEach(candidates) { candidate in
                // Il cast completo arriva da TMDB: quei person non sono quasi
                // mai indicizzati da noi, quindi si naviga per NOME — stesso
                // fallback che le card della scheda usano da sempre. Senza,
                // erano tappabili solo i pochi già in catalogo.
                NavigationLink {
                    // Filmografia TMDB, non ricerca nel nostro catalogo: queste
                    // persone quasi mai le abbiamo indicizzate, e cercarle per
                    // nome restituiva tre titoli su trenta.
                    PersonFilmographyView(
                        container: container,
                        session: session,
                        shell: shell,
                        personTMDBID: Int(candidate.personId) ?? 0,
                        personName: candidate.name,
                        avatarURL: candidate.profileURL
                    )
                } label: {
                    TitleCastCell(
                        candidate: candidate,
                        appreciation: CharacterAppreciation.from(
                            bucket: communityBucket,
                            personID: candidate.personId
                        ),
                        isMyPick: myPickIDs.contains(candidate.personId)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Dati

    private func load() async {
        // Il cast completo arriva da TMDB: in DB ci sono solo i primi 20.
        if let full = try? await container.titleRepository.fetchFullTitleCast(title: title),
           !full.isEmpty {
            candidates = full
        }
        isLoadingFullCast = false

        guard let uid = session.firebaseUser?.uid else { return }
        let mine = (try? await container.titleRepository.fetchMyCharacterPicksForItem(
            titleID: title.id,
            level: "title",
            season: 0,
            episode: 0,
            uid: uid
        )) ?? []
        myPickIDs = Set(mine.map(\.personId))
        if mode == .vote { picks = mine }
    }

    private func save() async {
        guard let uid = session.firebaseUser?.uid else { return }
        isSaving = true
        defer { isSaving = false }

        do {
            try await container.titleRepository.submitCharacterPicks(
                titleID: title.id,
                level: "title",
                season: 0,
                episode: 0,
                picks: picks,
                userID: uid
            )
            dismiss()
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}

// MARK: - Cella

private struct TitleCastCell: View {
    let candidate: CharacterCandidate
    let appreciation: CharacterAppreciation?
    var isMyPick: Bool = false

    var body: some View {
        VStack(spacing: 6) {
            photo
                .frame(width: 76, height: 76)
                .clipShape(Circle())

            Text(candidate.name)
                .font(.caption.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)
                .lineLimit(2)
                .multilineTextAlignment(.center)

            if let character = candidate.character, !character.isEmpty {
                Text(character)
                    .font(.caption2)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }

            if isMyPick {
                Label("Il tuo voto", systemImage: "checkmark.seal.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.success)
                    .labelStyle(.titleAndIcon)
            }

            if let appreciation {
                Text(appreciation.label)
                    .font(.caption2.weight(.black))
                    .foregroundStyle(TwoWatchTheme.brandPrimary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(
                        Capsule(style: .continuous)
                            .fill(TwoWatchTheme.brandPrimary.opacity(0.16))
                    )
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var photo: some View {
        if let url = candidate.profileURL {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                default:
                    initialsPlaceholder
                }
            }
        } else {
            initialsPlaceholder
        }
    }

    private var initialsPlaceholder: some View {
        ZStack {
            TwoWatchTheme.panelStrong
            Text(initials)
                .font(.subheadline.weight(.black))
                .foregroundStyle(TwoWatchTheme.textSecondary)
        }
    }

    private var initials: String {
        let parts = candidate.name.split(separator: " ").prefix(2).compactMap { $0.first }
        return parts.isEmpty ? "?" : String(parts).uppercased()
    }
}
