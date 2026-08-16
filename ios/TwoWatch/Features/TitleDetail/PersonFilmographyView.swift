import SwiftUI

/// Filmografia di una persona presa da TMDB, non dal nostro catalogo.
///
/// Serve al cast completo di una scheda: quelle persone arrivano da TMDB e
/// quasi nessuna è indicizzata da noi, quindi cercarle per nome nel catalogo
/// restituiva solo i pochi titoli che avevamo già — all'utente sembrava che
/// l'attore avesse recitato in tre cose. Qui si vede tutto quello che TMDB
/// sa, e il tap risolve il titolo esattamente come un risultato di ricerca
/// (lo apre se c'è, lo crea se manca).
struct PersonFilmographyView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let personTMDBID: Int
    let personName: String
    let avatarURL: URL?

    @State private var credits: [TMDBSearchResult] = []
    @State private var phase: Phase = .loading
    @State private var resolvingIDs: Set<String> = []
    @State private var errorMessage: String?

    private enum Phase {
        case loading
        case loaded
        case empty
        case failed
    }

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header

                switch phase {
                case .loading:
                    ProgressView()
                        .tint(TwoWatchTheme.brandPrimary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 48)
                case .empty:
                    EmptyStateView(
                        title: "Nessun titolo trovato",
                        message: "Non risultano altri film o serie per questa persona.",
                        systemImage: "film.stack"
                    )
                case .failed:
                    EmptyStateView(
                        title: "Qualcosa e' andato storto",
                        message: "Non siamo riusciti a caricare i titoli. Riprova tra poco.",
                        systemImage: "wifi.exclamationmark",
                        actionTitle: "Riprova",
                        action: { Task { await load() } }
                    )
                case .loaded:
                    grid
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
        }
        .background(TwoWatchBackground())
        .navigationTitle(personName)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .alert("Impossibile aprire il titolo", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("Chiudi", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Group {
                if let avatarURL {
                    CachedAsyncImage(url: avatarURL) { phase in
                        switch phase {
                        case let .success(image): image.resizable().scaledToFill()
                        default: TwoWatchTheme.panelStrong
                        }
                    }
                } else {
                    TwoWatchTheme.panelStrong
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(personName)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                if phase == .loaded {
                    Text("\(credits.count) titoli")
                        .font(.footnote)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var grid: some View {
        LazyVGrid(columns: columns, spacing: 16) {
            ForEach(credits) { item in
                Button {
                    Task { await open(item) }
                } label: {
                    SearchTMDBGridCell(item: item, isResolving: resolvingIDs.contains(item.id))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Dati

    private func load() async {
        phase = .loading
        do {
            let all = try await container.titleRepository.fetchTMDBPersonCredits(personTMDBID: personTMDBID)
            // Solo i ruoli da interprete: da una scheda titolo si arriva qui
            // tappando un volto del cast, non un reparto tecnico.
            let acting = all.filter { $0.role == .cast }.map(\.result)
            credits = acting.isEmpty ? all.map(\.result) : acting
            phase = credits.isEmpty ? .empty : .loaded
        } catch {
            phase = .failed
        }
    }

    /// Stesso percorso di un risultato di ricerca: se il titolo esiste lo apre,
    /// se manca lo crea. Nessun ramo separato da mantenere.
    private func open(_ item: TMDBSearchResult) async {
        guard !resolvingIDs.contains(item.id) else { return }
        resolvingIDs.insert(item.id)
        defer { resolvingIDs.remove(item.id) }

        do {
            let title = try await container.titleRepository.resolveTMDBSearchResult(
                item,
                localCandidates: [],
                currentUser: session.appUser
            )
            shell.activePresentedDestination = .title(id: title.id, focus: nil)
        } catch {
            errorMessage = UserFacingError.message(for: error)
        }
    }
}
