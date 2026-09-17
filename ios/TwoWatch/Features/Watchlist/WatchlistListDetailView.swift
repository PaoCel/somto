import SwiftUI

// Dettaglio di una lista: griglia dei titoli, header, azioni. Estratto da
// WatchlistView.swift.

struct WatchlistListItemGridCard: View {
    let item: UserListItem
    let canEdit: Bool
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let viewModel: WatchlistViewModel

    var body: some View {
        if let title = item.title {
            ZStack(alignment: .topTrailing) {
                NavigationLink {
                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        posterCard(title)

                        Text(title.name)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, minHeight: 34, alignment: .topLeading)

                        Text(item.completionText)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(statusColor)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                quickActionsMenu(title)
                    .padding(8)
            }
        }
    }

    private func posterCard(_ title: Title) -> some View {
        posterImage(title)
            .overlay(alignment: .topLeading) {
                typeBadge(title)
                    .padding(8)
            }
            .overlay(alignment: .bottomLeading) {
                if let provider = primaryProvider(title) {
                    WatchlistProviderLogoView(
                        name: provider.name,
                        logoURL: provider.logo,
                        height: 16,
                        textColor: .white
                    )
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(8)
                }
            }
    }

    private func posterImage(_ title: Title) -> some View {
        Group {
            if let url = title.posterPath {
                CachedAsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFill()
                    case .failure:
                        posterPlaceholder
                    case .empty:
                        ZStack {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(TwoWatchTheme.panelStrong)
                            ProgressView().tint(TwoWatchTheme.textSecondary)
                        }
                    @unknown default:
                        posterPlaceholder
                    }
                }
            } else {
                posterPlaceholder
            }
        }
        .frame(maxWidth: .infinity, minHeight: 150)
        .aspectRatio(2 / 3, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private var posterPlaceholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(TwoWatchTheme.panelStrong)
            Image(systemName: "film")
                .font(.title3)
                .foregroundStyle(TwoWatchTheme.textMuted)
        }
    }

    private func typeBadge(_ title: Title) -> some View {
        Label(title.type == .tv ? "Serie" : "Film", systemImage: title.type == .tv ? "tv" : "film")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(Color.black.opacity(0.66), in: Capsule())
    }

    private var statusColor: Color {
        item.personalState?.isInProgressSeries == true ? TwoWatchTheme.accent : TwoWatchTheme.textSecondary
    }

    private func primaryProvider(_ title: Title) -> (name: String, logo: URL?)? {
        guard let name = title.watchProviderNames.first else { return nil }
        return (name, title.watchProviderLogos[name])
    }

    @ViewBuilder
    private func quickActionsMenu(_ title: Title) -> some View {
        Menu {
            if title.type == .tv {
                Button {
                    guard let uid = session.firebaseUser?.uid else { return }
                    Task {
                        guard let result = await viewModel.advanceSeriesEpisode(userID: uid, title: title) else {
                            return
                        }
                        container.episodeSeenCoordinator.presentAfterAtomicAdvance(
                            title: title,
                            previousEpisodeCount: result.previousEpisodeCount,
                            updatedProgress: result.state.seriesProgress,
                            completesSeries: result.state.isCompleted,
                            hasTitleRating: result.state.hasTitleRating,
                            source: "custom_list_quick_menu"
                        )
                    }
                } label: {
                    Label("Avanza di un episodio", systemImage: "forward.end.fill")
                }

                Button {
                    guard let uid = session.firebaseUser?.uid else { return }
                    Task { await viewModel.markSeenFromList(userID: uid, title: title) }
                } label: {
                    Label("Segna come completata", systemImage: "checkmark.circle.fill")
                }
            } else {
                Button {
                    guard let uid = session.firebaseUser?.uid else { return }
                    Task { await viewModel.markSeenFromList(userID: uid, title: title) }
                } label: {
                    Label("Segna come visto", systemImage: "eye.fill")
                }
            }

            if canEdit {
                Divider()
                Button(role: .destructive) {
                    guard let uid = session.firebaseUser?.uid else { return }
                    Task { await viewModel.removeSelectedListItem(userID: uid, titleID: title.id) }
                } label: {
                    Label("Rimuovi dalla lista", systemImage: "trash")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.subheadline.weight(.black))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(Color.black.opacity(0.5), in: Circle())
                .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 1))
        }
        .accessibilityLabel("Azioni rapide")
    }
}

struct WatchlistListDetailView: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let detail: UserListDetail
    @Bindable var viewModel: WatchlistViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirm = false

    private var currentDetail: UserListDetail {
        viewModel.selectedListDetail ?? detail
    }

    private var isGeneralWatchlist: Bool {
        currentDetail.list.id == WatchlistRepository.generalWatchlistListID
    }

    /// Menu di gestione (Modifica / Elimina) disponibile solo al proprietario di
    /// una lista custom (non sulla watchlist generale, che è di sistema).
    private var showsOwnerManageMenu: Bool {
        !isGeneralWatchlist && currentDetail.list.isOwnedByCurrentUser
    }

    private var isPublicList: Bool {
        currentDetail.list.visibility == .public
    }

    private var generalWatchlistStates: [TitlePersonalState] {
        currentDetail.items
            .compactMap(\.personalState)
            .filter { state in
                state.isInToWatchQueue
            }
    }

    private var publicListItems: [UserListItem] {
        currentDetail.items
    }

    private var publicListCompletedCount: Int {
        publicListItems.reduce(into: 0) { partialResult, item in
            if item.publicProgress?.isCompleted == true {
                partialResult += 1
            }
        }
    }

    private let listGridColumns = [
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16)
    ]

    private func listParticipantProgressRow(_ progress: UserListProgressSummary) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(TwoWatchTheme.panelStrong)
                .frame(width: 42, height: 42)
                .overlay(
                    Text(progress.displayName.prefix(1))
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(progress.displayName)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Text("\(progress.completedCount)/\(progress.totalCount) completati • \(progress.progressText)")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                if let inProgressTitleName = progress.inProgressTitleName {
                    Text("In corso: \(inProgressTitleName)")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.accent)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    var body: some View {
        Group {
            if isGeneralWatchlist {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let ratingPromptTitle = viewModel.ratingPromptTitle {
                            WatchlistRatingReminderBanner(
                                title: ratingPromptTitle,
                                onOpenRating: {
                                    viewModel.openRatingPrompt(for: ratingPromptTitle)
                                },
                                onDismiss: {
                                    viewModel.dismissRatingPrompt()
                                }
                            )
                        }

                        generalWatchlistSummary

                        if generalWatchlistStates.isEmpty {
                            EmptyStateView(
                                title: "Watchlist vuota",
                                message: "Quando segni qualcosa da vedere, comparira qui.",
                                systemImage: "bookmark.slash.fill"
                            )
                        } else {
                            LazyVStack(spacing: 16) {
                                ForEach(generalWatchlistStates) { state in
                                    WatchlistStateCard(
                                        state: state,
                                        container: container,
                                        session: session,
                                        shell: shell,
                                        viewModel: viewModel,
                                        onToggleWatchlist: {
                                            guard let uid = session.firebaseUser?.uid else { return }
                                            Task { await viewModel.toggleGeneralWatchlist(userID: uid, state: state) }
                                        },
                                        onMarkSeen: {
                                            guard let uid = session.firebaseUser?.uid else { return }
                                            Task { await viewModel.markSeen(userID: uid, state: state) }
                                        },
                                        onAddToList: {
                                            guard let title = state.title else { return }
                                            viewModel.prepareCreateList(seedTitle: title)
                                        }
                                    )
                                }
                            }
                        }
                    }
                    .padding(20)
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
            } else if isPublicList {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        WatchlistListDetailHeader(
                            detail: currentDetail,
                            onEdit: {},
                            onTogglePin: {
                                guard let uid = session.firebaseUser?.uid else { return }
                                Task { await viewModel.togglePublicListPin(userID: uid, list: currentDetail.list) }
                            }
                        )

                        publicListSummary

                        LazyVStack(spacing: 16) {
                            ForEach(publicListItems) { item in
                                PublicListStateCard(
                                    item: item,
                                    listID: currentDetail.list.id,
                                    canManage: currentDetail.list.isOwnedByCurrentUser,
                                    container: container,
                                    session: session,
                                    shell: shell,
                                    viewModel: viewModel
                                )
                            }
                        }
                    }
                    .padding(20)
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        WatchlistListDetailHeader(detail: currentDetail) {
                            viewModel.prepareEditList(currentDetail)
                        }

                        if let next = currentDetail.nextSuggestedItem, let title = next.title {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Prossimo titolo")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                NavigationLink {
                                    TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
                                } label: {
                                    SearchTitleRow(title: title)
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        if !currentDetail.progress.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Progressi partecipanti")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                ForEach(currentDetail.progress) { progress in
                                    listParticipantProgressRow(progress)
                                }
                            }
                        }

                        if currentDetail.items.isEmpty {
                            EmptyStateView(
                                title: "Lista vuota",
                                message: "Aggiungi film e serie a questa lista per vederli qui in griglia.",
                                systemImage: "rectangle.stack.badge.plus"
                            )
                            .frame(maxWidth: .infinity)
                            .padding(.top, 12)
                        } else {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Titoli")
                                    .font(.subheadline.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textSecondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                LazyVGrid(columns: listGridColumns, spacing: 16) {
                                    ForEach(currentDetail.items) { item in
                                        WatchlistListItemGridCard(
                                            item: item,
                                            canEdit: currentDetail.list.canEdit,
                                            container: container,
                                            session: session,
                                            shell: shell,
                                            viewModel: viewModel
                                        )
                                    }
                                }
                            }
                        }
                    }
                    .padding(20)
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
            }
        }
        .background(TwoWatchBackground())
        .navigationTitle(currentDetail.list.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsOwnerManageMenu {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if currentDetail.list.canEdit {
                            Button {
                                viewModel.prepareEditList(currentDetail)
                            } label: {
                                Label("Modifica lista", systemImage: "pencil")
                            }
                        }
                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Label("Elimina lista", systemImage: "trash")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    .accessibilityLabel("Gestisci lista")
                }
            }
        }
        .confirmationDialog(
            "Eliminare la lista?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible
        ) {
            Button("Elimina lista", role: .destructive) {
                guard let uid = session.firebaseUser?.uid else { return }
                Task { await viewModel.deleteSelectedList(userID: uid) }
            }
            Button("Annulla", role: .cancel) {}
        } message: {
            Text("La lista \u{201C}\(currentDetail.list.title)\u{201D} verrà eliminata definitivamente. I titoli restano nella tua libreria e negli altri elenchi.")
        }
        .sheet(item: Binding(
            get: { viewModel.activeRatingContext },
            set: { viewModel.activeRatingContext = $0 }
        )) { context in
            NavigationStack {
                QuickRatingSheet(
                    title: context.title,
                    onSubmit: { value in
                        guard let uid = session.firebaseUser?.uid else { return }
                        Task { await viewModel.submitRating(userID: uid, title: context.title, value: value) }
                    },
                    onMarkLater: {
                        guard let uid = session.firebaseUser?.uid else { return }
                        Task { await viewModel.deferRating(userID: uid, title: context.title) }
                    }
                )
            }
            .watchlistActionFeedback(
                pendingMessage: viewModel.pendingActionMessage,
                successMessage: viewModel.successMessage
            )
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Chiudi") { dismiss() }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }
        }
    }

    private var generalWatchlistSummary: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text(currentDetail.list.title)
                    .font(.title3.weight(.black))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text("Solo titoli ancora da vedere. I contenuti già visti o da votare restano fuori da questa vista.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 10) {
                    StatusChip(text: "\(generalWatchlistStates.count) titoli", tint: TwoWatchTheme.success)
                    StatusChip(text: "Solo da vedere", tint: TwoWatchTheme.accent)
                    if generalWatchlistStates.contains(where: \.isInProgressSeries) {
                        StatusChip(text: "Include serie in corso", tint: TwoWatchTheme.brandWarm)
                    }
                }
            }
        }
    }

    private var publicListSummary: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Il tuo percorso")
                    .font(.title3.weight(.black))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                Text("Quello che segni qui vale solo per te. Non cambia la vista degli altri e può convivere con titoli che avevi già visto o votato.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                publicListProgressBar

                HStack(spacing: 10) {
                    StatusChip(text: currentDetail.list.isSavedByCurrentUser ? "Pinnata" : String(localized: "Non pinnata"), tint: currentDetail.list.isSavedByCurrentUser ? TwoWatchTheme.brandPrimary : TwoWatchTheme.textMuted)
                    if currentDetail.list.kind == .orderedPath {
                        StatusChip(text: "Percorso pubblico", tint: TwoWatchTheme.brandWarm)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var publicListProgressBar: some View {
        let total = max(currentDetail.list.itemCount, 1)
        let fraction = min(1, max(0, Double(publicListCompletedCount) / Double(total)))
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(publicListCompletedCount)/\(currentDetail.list.itemCount) completati")
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                Spacer(minLength: 8)
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(TwoWatchTheme.accent)
            }
            ProgressView(value: fraction)
                .tint(TwoWatchTheme.accent)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Progresso percorso")
        .accessibilityValue("\(publicListCompletedCount) di \(currentDetail.list.itemCount) completati")
    }
}

struct WatchlistListDetailHeader: View {
    let detail: UserListDetail
    let onEdit: () -> Void
    var onTogglePin: (() -> Void)? = nil

    @ScaledMetric(relativeTo: .body) private var coverHeight: CGFloat = 190

    private var list: UserListSummary { detail.list }

    private var visibilityTint: Color {
        switch list.visibility {
        case .public: return TwoWatchTheme.accent
        case .shared: return TwoWatchTheme.brandPrimary
        case .private: return TwoWatchTheme.textMuted
        }
    }

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 14) {
                WatchlistListCoverView(list: list)
                    .frame(height: coverHeight)

                VStack(alignment: .leading, spacing: 6) {
                    Text(list.title)
                        .font(.title3.weight(.black))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let description = list.description, !description.isEmpty {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 10) {
                    StatusChip(text: list.visibility.label, tint: visibilityTint)
                    StatusChip(text: list.kind.label, tint: TwoWatchTheme.brandWarm)
                    StatusChip(text: "\(list.itemCount) titoli", tint: TwoWatchTheme.success)
                    if list.visibility == .public, list.followersCount > 0 {
                        StatusChip(text: "\(list.followersCount) follower", tint: TwoWatchTheme.brandPrimary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                actionRow
            }
        }
    }

    @ViewBuilder
    private var actionRow: some View {
        let showsShare = list.visibility == .public
        let showsPin = list.visibility == .public && onTogglePin != nil
        let showsEdit = list.canEdit && list.visibility != .public

        if showsShare || showsPin || showsEdit {
            HStack(spacing: 10) {
                if showsPin, let onTogglePin {
                    Button {
                        onTogglePin()
                    } label: {
                        Label(
                            list.isSavedByCurrentUser ? "Togli pin" : "Pinna",
                            systemImage: list.isSavedByCurrentUser ? "pin.slash.fill" : "pin.fill"
                        )
                    }
                    .buttonStyle(TitleOutlineButtonStyle(tint: list.isSavedByCurrentUser ? TwoWatchTheme.brandPrimary : TwoWatchTheme.accent))
                    .accessibilityLabel(list.isSavedByCurrentUser ? "Togli la lista dai preferiti" : "Aggiungi la lista ai preferiti")
                }

                if showsShare, let shareURL = list.shareURL {
                    ShareLink(item: shareURL, subject: Text(list.title), message: Text("Guarda questa lista su Somto")) {
                        Label("Condividi", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.accent))
                    .accessibilityLabel("Condividi la lista")
                }

                if showsEdit {
                    Button {
                        onEdit()
                    } label: {
                        Label("Modifica", systemImage: "pencil")
                    }
                    .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.accent))
                    .accessibilityLabel("Modifica la lista")
                }
            }
        }
    }
}
