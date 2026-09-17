import SwiftUI

// Sezione "Visti": strip dei filtri per categoria, tab dei contenuti e la
// griglia dei titoli. Estratti da ProfileComponents.swift.

struct ProfileCategoryFilterStrip: View {
    let counts: [ContentCategory: Int]
    @Binding var selected: Set<ContentCategory>
    /// Invocato dopo il toggle: il parent lo usa per switchare sul tab "Visti".
    var onSelect: (ContentCategory) -> Void = { _ in }

    var body: some View {
        HStack(alignment: .center, spacing: 0) {
            ForEach(Array(ContentCategory.allCases.enumerated()), id: \.element) { index, category in
                if index != 0 {
                    Rectangle()
                        .fill(TwoWatchTheme.border)
                        .frame(width: 1, height: 40)
                        .accessibilityHidden(true) // separatore decorativo
                }
                column(for: category)
            }
        }
        .padding(6)
        .background(TwoWatchTheme.panel.opacity(0.5), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func column(for category: ContentCategory) -> some View {
        let count = counts[category] ?? 0
        let isEmpty = count == 0
        let isActive = selected.contains(category)
        return Button {
            guard !isEmpty else { return }
            if selected.contains(category) {
                selected.remove(category)
            } else {
                selected.insert(category)
            }
            onSelect(category)
        } label: {
            VStack(spacing: 3) {
                Image(systemName: category.symbolName)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(isActive ? category.accentColor : (isEmpty ? TwoWatchTheme.textMuted : TwoWatchTheme.textSecondary))
                Text("\(count)")
                    .font(.system(size: 20, weight: .black, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(isEmpty ? TwoWatchTheme.textMuted : TwoWatchTheme.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(category.label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(isActive ? category.accentColor : TwoWatchTheme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isActive ? category.accentColor.opacity(0.18) : Color.clear)
            )
        }
        .buttonStyle(.plain)
        .disabled(isEmpty)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(category.label): \(count) visti")
        .accessibilityHint(isEmpty ? "" : "Tocca per filtrare i visti per \(category.label)")
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }
}

struct ProfileContentTabs: View {
    @Binding var selection: ProfileContentTab
    @Namespace private var selectionNamespace

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(ProfileContentTab.allCases) { tab in
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) {
                            selection = tab
                        }
                    } label: {
                        VStack(spacing: 10) {
                            Text(LocalizedStringKey(tab.title))
                                .font(.subheadline.weight(.bold))
                                .foregroundStyle(selection == tab ? Color(hex: "#131826") : Color(hex: "#6B7280"))

                            ZStack {
                                Capsule()
                                    .fill(Color.clear)
                                    .frame(height: 3)

                                if selection == tab {
                                    Capsule()
                                        .fill(TwoWatchTheme.brandPrimary)
                                        .frame(height: 3)
                                        .matchedGeometryEffect(id: "profile-tab", in: selectionNamespace)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    // Segnala VoiceOver se il tab è selezionato
                    .accessibilityAddTraits(selection == tab ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.horizontal, 2)
            .padding(.top, 2)
            .padding(.bottom, 8)

            Rectangle()
                .fill(Color.black.opacity(0.08))
                .frame(height: 1)
        }
    }
}

struct ProfileWatchedTitlesSection: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let entries: [LibraryEntry]
    /// Avanzamento per serie (per titleId). Una entry presente = serie iniziata.
    var seriesProgress: [String: TitleSeriesProgress] = [:]
    /// Filtro tipo (multi-select, come sul web). Vuoto = tutte. Pilotato dalla
    /// strip contatori-filtro nel blocco "Tempo di visione" del parent, non più
    /// da una strip interna a questa sezione.
    @Binding var selectedCategories: Set<ContentCategory>
    /// Emozioni scelte dalla persona, per titolo. Serve al filtro "Emozione":
    /// vuoto = filtro nascosto (nessun dato da filtrare).
    var emotionsByTitleID: [String: [TitleEmotion]] = [:]
    var isLoading = false
    var embedsInCard = true
    /// Solo sul proprio profilo: abilita le azioni distruttive (rimuovi voto /
    /// segna come non visto) nel context menu delle locandine.
    var isOwnProfile = false
    /// Invocato dopo una mutazione riuscita così il parent ricarica la libreria.
    var onLibraryChanged: () -> Void = {}

    @State private var searchText = ""
    @State private var selectedStatusFilter: ProfileWatchedStatusFilter = .all
    @State private var selectedRatingFilter: ProfileWatchedRatingFilter = .all
    @State private var selectedEmotion: TitleEmotion?
    @State private var visibleCount = 12
    @State private var pendingRemoveRating: LibraryEntry?
    @State private var pendingUnsee: LibraryEntry?
    @State private var actionErrorMessage: String?
    @State private var inFlightTitleIDs: Set<String> = []

    private let batchSize = 12
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 14), count: 3)
    private let textPrimary = Color(hex: "#131826")
    private let textSecondary = Color(hex: "#4B5563")
    private let textMuted = Color(hex: "#6B7280")
    private let cardBackground = Color(hex: "#FCFBF6")
    private let cardBorder = Color.black.opacity(0.08)

    private var normalizedQuery: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var filteredEntries: [LibraryEntry] {
        entries.filter { entry in
            guard let title = entry.title else { return false }

            let matchesFilter = selectedCategories.isEmpty
                || selectedCategories.contains(title.profileContentCategory)

            guard matchesFilter else { return false }

            let matchesStatus: Bool
            switch selectedStatusFilter {
            case .all:
                // "Visti" = titoli finiti. La proiezione `library` include anche
                // le serie iniziate e non finite: mostrarle qui faceva dire alla
                // griglia un numero diverso dal contatore (fino a +181 titoli).
                // Restano raggiungibili dal chip "In corso" qui sotto e dalla
                // Watchlist.
                matchesStatus = entry.isCompletedWatch
            case .inProgress:
                matchesStatus = entry.isInProgress
            case .rated:
                matchesStatus = entry.hasRating
            case .rewatched:
                matchesStatus = entry.completedCount > 1
            }

            guard matchesStatus else { return false }
            guard selectedRatingFilter.matches(entry.lastRating) else { return false }

            if let selectedEmotion {
                let entryEmotions = emotionsByTitleID[entry.titleId] ?? []
                guard entryEmotions.contains(selectedEmotion) else { return false }
            }

            guard normalizedQuery.isEmpty == false else { return true }

            return title.name.lowercased().contains(normalizedQuery)
                || title.subtitle.lowercased().contains(normalizedQuery)
                || title.genres.joined(separator: " ").lowercased().contains(normalizedQuery)
        }
    }

    /// Ordinamento: col filtro voto attivo si guarda "i suoi 10", quindi i voti
    /// più alti prima; altrimenti resta l'ordine di libreria.
    private var sortedFilteredEntries: [LibraryEntry] {
        guard selectedRatingFilter != .all else { return filteredEntries }
        return filteredEntries.sorted { lhs, rhs in
            let l = lhs.lastRating ?? -1
            let r = rhs.lastRating ?? -1
            if l != r { return l > r }
            return (lhs.ratedAt ?? .distantPast) > (rhs.ratedAt ?? .distantPast)
        }
    }

    /// Emozioni davvero usate dalla persona, in ordine canonico. Il filtro si
    /// mostra solo se ce n'è almeno una: su un profilo senza emozioni sarebbe
    /// una fila di chip che non filtrano niente.
    private var availableEmotions: [TitleEmotion] {
        guard !emotionsByTitleID.isEmpty else { return [] }
        let used = Set(emotionsByTitleID.values.flatMap { $0 })
        return TitleEmotion.allCases.filter { used.contains($0) }
    }

    private var visibleEntries: [LibraryEntry] {
        Array(sortedFilteredEntries.prefix(visibleCount))
    }

    private var hasMoreEntries: Bool {
        visibleEntries.count < filteredEntries.count
    }

    private var summaryText: String {
        normalizedQuery.isEmpty ? "\(filteredEntries.count) titoli" : "\(filteredEntries.count) risultati"
    }

    /// Messaggio di stato vuoto specifico per il filtro stato selezionato,
    /// mostrato quando esistono titoli in libreria ma nessuno passa i filtri correnti.
    private var statusEmptyMessage: String {
        switch selectedStatusFilter {
        case .all:
            return "Prova a cambiare filtro o a cercare un altro titolo nella libreria dell'utente."
        case .inProgress:
            return String(localized: "Nessuna serie in corso al momento con questi filtri.")
        case .rated:
            return String(localized: "Nessun titolo votato con questi filtri.")
        case .rewatched:
            return String(localized: "Nessun titolo rivisto più volte con questi filtri.")
        }
    }

    /// Filtro secondario per stato (Tutti/In corso/Votati/Rivisti), ortogonale
    /// al filtro tipo (la strip contatori nel blocco "Tempo di visione").
    /// Estratto per far respirare il type-checker.
    private var statusFilterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ProfileWatchedStatusFilter.allCases) { filter in
                    Button {
                        selectedStatusFilter = filter
                        visibleCount = batchSize
                    } label: {
                        Text(filter.title)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .foregroundStyle(selectedStatusFilter == filter ? .white : textSecondary)
                            .background(
                                Capsule()
                                    .fill(selectedStatusFilter == filter ? TwoWatchTheme.brandSecondary : Color(hex: "#EFF1F5"))
                            )
                    }
                    .buttonStyle(.plain)
                    // Segnala VoiceOver se il filtro è attivo
                    .accessibilityAddTraits(selectedStatusFilter == filter ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.trailing, 2)
        }
    }

    /// Voto ed emozione sulla stessa riga, come due menu compatti: due file di
    /// chip in più avrebbero raddoppiato l'altezza dei filtri prima ancora di
    /// vedere una locandina.
    private var ratingAndEmotionRow: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Voto", selection: $selectedRatingFilter) {
                    ForEach(ProfileWatchedRatingFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
            } label: {
                filterChipLabel(
                    icon: "star.fill",
                    text: selectedRatingFilter == .all ? "Voto" : selectedRatingFilter.title,
                    isActive: selectedRatingFilter != .all
                )
            }
            .onChange(of: selectedRatingFilter) { _, _ in visibleCount = batchSize }
            .accessibilityLabel("Filtra per voto")

            if !availableEmotions.isEmpty {
                Menu {
                    Button("Ogni emozione") { selectedEmotion = nil }
                    ForEach(availableEmotions) { emotion in
                        Button("\(emotion.emoji) \(emotion.label)") { selectedEmotion = emotion }
                    }
                } label: {
                    filterChipLabel(
                        icon: nil,
                        text: selectedEmotion.map { "\($0.emoji) \($0.label)" } ?? "Emozione",
                        isActive: selectedEmotion != nil
                    )
                }
                .onChange(of: selectedEmotion) { _, _ in visibleCount = batchSize }
                .accessibilityLabel("Filtra per emozione")
            }

            Spacer(minLength: 0)

            if selectedRatingFilter != .all || selectedEmotion != nil {
                Button("Azzera") {
                    selectedRatingFilter = .all
                    selectedEmotion = nil
                    visibleCount = batchSize
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.brandSecondary)
            }
        }
    }

    private func filterChipLabel(icon: String?, text: String, isActive: Bool) -> some View {
        HStack(spacing: 5) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
            }
            Text(text)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .bold))
        }
        .foregroundStyle(isActive ? .white : textSecondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            Capsule().fill(isActive ? TwoWatchTheme.brandSecondary : Color(hex: "#EFF1F5"))
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(textMuted)
                TextField("Cerca un titolo visto", text: $searchText)
                    .foregroundStyle(textPrimary)
                    .tint(textPrimary)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color(hex: "#F5F7FA"), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Color.black.opacity(0.06), lineWidth: 1)
            )

            statusFilterRow
            ratingAndEmotionRow

            HStack {
                Text(summaryText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(textSecondary)

                Spacer()
            }

            if isLoading && entries.isEmpty {
                GlassCard {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 20)
                        .tint(TwoWatchTheme.textPrimary)
                }
            } else if filteredEntries.isEmpty {
                if entries.isEmpty {
                    EmptyStateView(
                        title: "Ancora niente qui",
                        message: "Ancora niente qui. Salva un titolo in Watchlist e segnalo come visto: comparirà in questa libreria.",
                        systemImage: "film.stack.fill"
                    )
                } else {
                    EmptyStateView(
                        title: "Nessun titolo trovato",
                        message: LocalizedStringKey(statusEmptyMessage),
                        systemImage: "film.stack.fill"
                    )
                }
            } else {
                LazyVGrid(columns: columns, spacing: 20) {
                    ForEach(visibleEntries) { entry in
                        if let title = entry.title {
                            ZStack {
                                NavigationLink {
                                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                                } label: {
                                    ProfilePosterTile(
                                        entry: entry,
                                        title: title,
                                        seriesProgress: seriesProgress[entry.titleId]
                                    )
                                }
                                .buttonStyle(.plain)
                                .disabled(inFlightTitleIDs.contains(entry.titleId))

                                if inFlightTitleIDs.contains(entry.titleId) {
                                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                                        .fill(Color.black.opacity(0.45))
                                    VStack(spacing: 6) {
                                        ProgressView()
                                            .tint(.white)
                                        Text("Salvataggio…")
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(.white)
                                    }
                                    .accessibilityElement(children: .combine)
                                    .accessibilityLabel("Salvataggio titolo in corso")
                                }
                            }
                            .contextMenu {
                                if isOwnProfile {
                                    if entry.hasRating {
                                        Button(role: .destructive) {
                                            pendingRemoveRating = entry
                                        } label: {
                                            Label("Rimuovi voto", systemImage: "star.slash.fill")
                                        }
                                        .disabled(inFlightTitleIDs.contains(entry.titleId))
                                    }
                                    Button(role: .destructive) {
                                        pendingUnsee = entry
                                    } label: {
                                        Label("Segna come non visto", systemImage: "eye.slash.fill")
                                    }
                                    .disabled(inFlightTitleIDs.contains(entry.titleId))
                                }
                            }
                        }
                    }
                }

                if hasMoreEntries {
                    Button {
                        visibleCount += batchSize
                    } label: {
                        Text("Carica altri")
                            .font(.subheadline.weight(.bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.white)
                    .background(TwoWatchTheme.brandPrimary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
        }
        .onChange(of: searchText) { _, _ in
            visibleCount = batchSize
        }
        .onChange(of: selectedCategories) { _, _ in
            visibleCount = batchSize
        }
        .onChange(of: selectedStatusFilter) { _, _ in
            visibleCount = batchSize
        }
        .modifier(CardChromeModifier(
            isEnabled: embedsInCard,
            padding: 18,
            cornerRadius: 26,
            background: cardBackground,
            border: cardBorder,
            shadowOpacity: 0.10
        ))
        .confirmationDialog(
            "Rimuovere il voto?",
            isPresented: removeRatingBinding,
            titleVisibility: .visible
        ) {
            Button("Rimuovi voto", role: .destructive) {
                if let entry = pendingRemoveRating { performRemoveRating(entry) }
                pendingRemoveRating = nil
            }
            Button("Annulla", role: .cancel) { pendingRemoveRating = nil }
        } message: {
            Text("Il titolo resta tra i visti, ma senza voto. Potrai rivotarlo quando vuoi.")
        }
        .confirmationDialog(
            unseeDialogTitle,
            isPresented: unseeBinding,
            titleVisibility: .visible
        ) {
            Button(unseeDialogButton, role: .destructive) {
                if let entry = pendingUnsee { performUnsee(entry) }
                pendingUnsee = nil
            }
            Button("Annulla", role: .cancel) { pendingUnsee = nil }
        } message: {
            Text(unseeDialogMessage)
        }
        .alert(
            "Operazione non riuscita",
            isPresented: Binding(
                get: { actionErrorMessage != nil },
                set: { if !$0 { actionErrorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { actionErrorMessage = nil }
        } message: {
            Text(actionErrorMessage ?? "")
        }
    }

    private var removeRatingBinding: Binding<Bool> {
        Binding(
            get: { pendingRemoveRating != nil },
            set: { if !$0 { pendingRemoveRating = nil } }
        )
    }

    private var unseeBinding: Binding<Bool> {
        Binding(
            get: { pendingUnsee != nil },
            set: { if !$0 { pendingUnsee = nil } }
        )
    }

    private var unseeIsRated: Bool {
        pendingUnsee?.hasRating == true
    }

    private var unseeIsMovie: Bool {
        pendingUnsee?.title?.type == .movie
    }

    private var unseeDialogTitle: String {
        unseeIsMovie ? "Segnare come non visto?" : "Riazzerare il progresso?"
    }

    private var unseeDialogButton: String {
        unseeIsRated ? "Rimuovi voto e visto" : (unseeIsMovie ? "Segna non visto" : "Riazzera")
    }

    private var unseeDialogMessage: String {
        if unseeIsMovie {
            return unseeIsRated
                ? "Il film tornerà tra i titoli da vedere e il tuo voto verrà rimosso."
                : "Il film tornerà tra i titoli da vedere."
        }
        return unseeIsRated
            ? "La serie tornerà a 'Da vedere': gli episodi tracciati e il tuo voto verranno rimossi."
            : "La serie tornerà a 'Da vedere' e gli episodi tracciati verranno rimossi."
    }

    private func performRemoveRating(_ entry: LibraryEntry) {
        guard isOwnProfile, let uid = session.firebaseUser?.uid,
              !inFlightTitleIDs.contains(entry.titleId) else { return }
        inFlightTitleIDs.insert(entry.titleId)
        Task {
            defer { inFlightTitleIDs.remove(entry.titleId) }
            do {
                try await container.titleRepository.deleteRating(
                    userID: uid,
                    titleID: entry.titleId,
                    level: "title"
                )
                onLibraryChanged()
            } catch {
                actionErrorMessage = UserFacingError.message(for: error)
            }
        }
    }

    private func performUnsee(_ entry: LibraryEntry) {
        guard isOwnProfile,
              let uid = session.firebaseUser?.uid,
              let title = entry.title,
              !inFlightTitleIDs.contains(entry.titleId) else { return }
        inFlightTitleIDs.insert(entry.titleId)
        Task {
            defer { inFlightTitleIDs.remove(entry.titleId) }
            do {
                // Cancella prima il voto generale (se presente) per non lasciare
                // un voto orfano nell'aggregato community.
                if entry.hasRating {
                    try await container.titleRepository.deleteRating(
                        userID: uid,
                        titleID: entry.titleId,
                        level: "title"
                    )
                }
                switch title.type {
                case .movie:
                    _ = try await container.watchlistRepository.markMovieUnseen(userID: uid, title: title)
                case .tv:
                    _ = try await container.watchlistRepository.markSeriesUnstarted(userID: uid, title: title)
                }
                onLibraryChanged()
            } catch {
                actionErrorMessage = UserFacingError.message(for: error)
            }
        }
    }
}

/// Voce unificata del timeline "Attività": recensione, emozione o post
/// pubblico, ordinabili tutte insieme in ordine reverse-chron.
