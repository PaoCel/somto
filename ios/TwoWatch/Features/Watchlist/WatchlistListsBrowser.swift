@preconcurrency import FirebaseStorage
import SwiftUI
import ImageIO

// Esplorazione delle liste: filtro e browser delle liste pubbliche, righe
// della libreria personale, copertine. Estratti da WatchlistView.swift.

enum PublicListsBrowserFilter: String, CaseIterable, Identifiable {
    case all
    case collections
    case paths
    case editorial

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "Tutte"
        case .collections: return "Raccolte"
        case .paths: return "Percorsi"
        case .editorial: return "Editoriali"
        }
    }

    var symbolName: String {
        switch self {
        case .all: return "square.grid.2x2.fill"
        case .collections: return "rectangle.stack.fill"
        case .paths: return "point.3.connected.trianglepath.dotted"
        case .editorial: return "star.fill"
        }
    }
}

extension UserListSummary {
    /// Editorial lists are seeded server-side and carry an `editorialSlug`.
    var isEditorial: Bool {
        !(editorialSlug?.isEmpty ?? true)
    }
}

struct PublicListsBrowserView: View {
    let lists: [UserListSummary]
    let viewModel: WatchlistViewModel
    let onOpenList: (UserListSummary) -> Void
    let onTogglePin: (UserListSummary) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var filter: PublicListsBrowserFilter = .all

    private func sorted(_ lists: [UserListSummary]) -> [UserListSummary] {
        lists.sorted { lhs, rhs in
            if lhs.isSavedByCurrentUser != rhs.isSavedByCurrentUser {
                return lhs.isSavedByCurrentUser && !rhs.isSavedByCurrentUser
            }
            if lhs.followersCount != rhs.followersCount {
                return lhs.followersCount > rhs.followersCount
            }
            let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? .distantPast
            let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? .distantPast
            if lhsDate != rhsDate {
                return lhsDate > rhsDate
            }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    private var filteredLists: [UserListSummary] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = lists.filter { list in
            switch filter {
            case .all: return true
            case .collections: return list.kind == .collection
            case .paths: return list.kind == .orderedPath
            case .editorial: return list.isEditorial
            }
        }
        let matched = trimmed.isEmpty ? base : base.filter { list in
            list.title.localizedCaseInsensitiveContains(trimmed)
                || (list.description?.localizedCaseInsensitiveContains(trimmed) ?? false)
        }
        return sorted(matched)
    }

    /// Editorial lists surfaced in their own section at the top (only on the
    /// "all" filter, so the dedicated "Editoriali" chip stays a flat list).
    private var editorialLists: [UserListSummary] {
        guard filter == .all, query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return sorted(lists.filter(\.isEditorial))
    }

    private var otherLists: [UserListSummary] {
        guard !editorialLists.isEmpty else { return filteredLists }
        let editorialIDs = Set(editorialLists.map(\.id))
        return filteredLists.filter { !editorialIDs.contains($0.id) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                Text("Tutte le liste pubbliche che puoi seguire. Il progresso che segni qui resta personale.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                filterChips

                if filteredLists.isEmpty {
                    EmptyStateView(
                        title: query.isEmpty ? "Nessuna lista" : "Nessun risultato",
                        message: query.isEmpty
                            ? "Non ci sono ancora liste pubbliche in questa categoria."
                            : "Nessuna lista pubblica corrisponde a “\(query)”.",
                        systemImage: "rectangle.stack.badge.minus"
                    )
                    .padding(.top, 12)
                } else {
                    if !editorialLists.isEmpty {
                        sectionHeader("In evidenza", systemImage: "star.fill", tint: TwoWatchTheme.brandWarm)
                        publicListsGrid(editorialLists)
                    }

                    if !otherLists.isEmpty {
                        sectionHeader(
                            editorialLists.isEmpty ? "Liste disponibili" : "Altre liste",
                            systemImage: "rectangle.stack.fill",
                            tint: TwoWatchTheme.accent
                        )
                        publicListsGrid(otherLists)
                    }
                }
            }
            .padding(20)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(TwoWatchBackground())
        .navigationTitle("Liste Pubbliche")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Cerca una lista")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Chiudi") { dismiss() }
            }
        }
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(PublicListsBrowserFilter.allCases) { option in
                    let isSelected = filter == option
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) { filter = option }
                    } label: {
                        Label(option.label, systemImage: option.symbolName)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(isSelected ? TwoWatchTheme.background : TwoWatchTheme.textPrimary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .frame(minHeight: 44)
                            .background(
                                Capsule().fill(
                                    isSelected
                                        ? AnyShapeStyle(TwoWatchTheme.brandGradient)
                                        : AnyShapeStyle(TwoWatchTheme.panelStrong)
                                )
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(option.label)
                    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func sectionHeader(_ text: String, systemImage: String, tint: Color) -> some View {
        Label(text, systemImage: systemImage)
            .font(.subheadline.weight(.black))
            .foregroundStyle(tint)
            .padding(.top, 4)
    }

    /// Griglia 3 colonne: le righe a tutta larghezza con descrizione e tre chip
    /// rendevano il catalogo un muro. Copertina + nome + conteggio bastano per
    /// scegliere; il resto sta nel dettaglio.
    private func publicListsGrid(_ lists: [UserListSummary]) -> some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 10),
                      GridItem(.flexible(), spacing: 10),
                      GridItem(.flexible(), spacing: 10)],
            alignment: .leading,
            spacing: 16
        ) {
            ForEach(lists) { list in
                WatchlistListGridCard(list: list, showsOwner: true) {
                    dismiss()
                    onOpenList(list)
                }
            }
        }
    }

    private func row(for list: UserListSummary) -> some View {
        PublicListBrowserRow(
            list: list,
            onOpen: {
                dismiss()
                onOpenList(list)
            },
            onTogglePin: { onTogglePin(list) },
            isSaved: viewModel.isPublicListSaved(list),
            isPinToggleInFlight: viewModel.pinTogglesInFlight.contains(list.id)
        )
    }
}

/// Riga compatta riusabile per le liste dell'utente (private/condivise/salvate).
/// Mostra copertina + titolo + descrizione + badge visibilità + numero titoli.
/// Tap → apre la lista. Pulsante pin opzionale (solo per liste pubbliche salvate).
struct WatchlistLibraryListRow: View {
    let list: UserListSummary
    let onOpen: () -> Void
    var onTogglePin: (() -> Void)? = nil
    /// Stato pin da mostrare (override ottimistico se presente). Default al
    /// valore del modello per i chiamanti che non passano pin (liste condivise).
    var isSaved: Bool? = nil
    /// True mentre la toggle-pin di questa lista è in volo: disabilita il
    /// bottone e mostra uno spinner al posto dell'icona pin.
    var isPinToggleInFlight: Bool = false

    @ScaledMetric(relativeTo: .body) private var coverWidth: CGFloat = 96
    @ScaledMetric(relativeTo: .body) private var coverHeight: CGFloat = 70
    // Altezza riga fissa: senza questa, righe con/senza descrizione (1-2 righe)
    // avevano altezze diverse e sembravano "non uniformi" nell'elenco.
    private let rowMinHeight: CGFloat = 96

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: 14) {
                    WatchlistListCoverView(list: list)
                        .frame(width: coverWidth, height: coverHeight)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Text(list.title)
                            .font(.subheadline.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if let description = list.description, !description.isEmpty {
                            Text(description)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        HStack(spacing: 8) {
                            badge(list.visibility.label, systemName: list.visibility.symbolName)
                            badge("\(list.itemCount)", systemName: "film.stack.fill")
                            Spacer(minLength: 0)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let onTogglePin {
                let saved = isSaved ?? list.isSavedByCurrentUser
                Button(action: onTogglePin) {
                    if isPinToggleInFlight {
                        ProgressView()
                            .tint(TwoWatchTheme.textMuted)
                            .frame(width: 44, height: 44)
                            .background(TwoWatchTheme.panelStrong, in: Circle())
                    } else {
                        Image(systemName: saved ? "pin.fill" : "pin")
                            .font(.subheadline.weight(.black))
                            .foregroundStyle(saved ? TwoWatchTheme.accent : TwoWatchTheme.textMuted)
                            .frame(width: 44, height: 44)
                            .background(TwoWatchTheme.panelStrong, in: Circle())
                    }
                }
                .buttonStyle(.plain)
                .disabled(isPinToggleInFlight)
                .accessibilityLabel(saved ? "Togli la lista dai preferiti" : "Aggiungi la lista ai preferiti")
                .accessibilityAddTraits(saved ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: rowMinHeight, alignment: .leading)
        .background(TwoWatchTheme.backgroundSecondary.opacity(0.96), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func badge(_ value: String, systemName: String) -> some View {
        Label(value, systemImage: systemName)
            .font(.caption2.weight(.bold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(TwoWatchTheme.panelStrong, in: Capsule())
    }
}

/// Sezione "Le tue liste" (area Home): elenco a righe di liste private, condivise
/// e pubbliche salvate. Non renderizza nulla se l'elenco combinato è vuoto.
struct WatchlistMyListsSection: View {
    let lists: [UserListSummary]
    let onOpenList: (UserListSummary) -> Void

    var body: some View {
        if !lists.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Le tue liste")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)

                VStack(spacing: 12) {
                    ForEach(lists) { list in
                        WatchlistLibraryListRow(list: list) {
                            onOpenList(list)
                        }
                    }
                }
            }
        }
    }
}

struct PublicListBrowserRow: View {
    let list: UserListSummary
    let onOpen: () -> Void
    let onTogglePin: () -> Void
    var isSaved: Bool? = nil
    var isPinToggleInFlight: Bool = false

    @ScaledMetric(relativeTo: .body) private var coverWidth: CGFloat = 108
    @ScaledMetric(relativeTo: .body) private var coverHeight: CGFloat = 78
    // Altezza riga fissa: uniforma le righe con/senza descrizione o badge follower.
    private let rowMinHeight: CGFloat = 104

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: 14) {
                    WatchlistListCoverView(list: list)
                        .frame(width: coverWidth, height: coverHeight)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Text(list.title)
                            .font(.subheadline.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if let description = list.description, !description.isEmpty {
                            Text(description)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        HStack(spacing: 8) {
                            compactBrowserMeta(list.kind.label, systemName: list.kind.symbolName)
                            compactBrowserMeta("\(list.itemCount)", systemName: "film.stack.fill")
                            if list.followersCount > 0 {
                                compactBrowserMeta("\(list.followersCount)", systemName: "person.2.fill")
                            }
                            Spacer(minLength: 0)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            let saved = isSaved ?? list.isSavedByCurrentUser
            Button(action: onTogglePin) {
                if isPinToggleInFlight {
                    ProgressView()
                        .tint(TwoWatchTheme.textMuted)
                        .frame(width: 44, height: 44)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                } else {
                    Image(systemName: saved ? "pin.fill" : "pin")
                        .font(.subheadline.weight(.black))
                        .foregroundStyle(saved ? TwoWatchTheme.accent : TwoWatchTheme.textMuted)
                        .frame(width: 44, height: 44)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                }
            }
            .buttonStyle(.plain)
            .disabled(isPinToggleInFlight)
            .accessibilityLabel(saved ? "Togli la lista dai preferiti" : "Aggiungi la lista ai preferiti")
            .accessibilityAddTraits(saved ? [.isButton, .isSelected] : .isButton)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: rowMinHeight, alignment: .leading)
        .background(TwoWatchTheme.backgroundSecondary.opacity(0.96), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }

    private func compactBrowserMeta(_ value: String, systemName: String) -> some View {
        Label(value, systemImage: systemName)
            .font(.caption2.weight(.bold))
            .foregroundStyle(TwoWatchTheme.textPrimary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(TwoWatchTheme.panelStrong, in: Capsule())
    }
}

struct WatchlistListCoverView: View {
    let list: UserListSummary

    // Manual tuning knob for the generic Watchlist strip in preview and runtime cards.
    private let generalWatchlistPosterWidth: CGFloat = 50

    private var isGeneralWatchlist: Bool {
        list.id == WatchlistRepository.generalWatchlistListID
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Group {
                if let storagePath = list.cover.storagePath, !storagePath.isEmpty {
                    WatchlistSecureCoverImage(storagePath: storagePath, fallbackURL: list.cover.imageURL) {
                        fallback
                    }
                } else if let imageURL = list.cover.imageURL {
                    CachedAsyncImage(url: imageURL) { phase in
                        switch phase {
                        case let .success(image):
                            image.resizable().scaledToFill()
                        default:
                            fallback
                        }
                    }
                } else {
                    fallback
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            LinearGradient(
                colors: [Color.clear, Color.black.opacity(0.78)],
                startPoint: .top,
                endPoint: .bottom
            )

            HStack(spacing: 8) {
                Image(systemName: list.kind.symbolName)
                    .font(.caption.weight(.bold))
                Text(list.kind.label)
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.black.opacity(0.35), in: Capsule())
            .padding(12)
        }
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .clipped()
    }

    private var fallback: some View {
        ZStack {
            LinearGradient(
                colors: [
                    TwoWatchTheme.brandPrimary.opacity(0.9),
                    TwoWatchTheme.brandWarm.opacity(0.82),
                    TwoWatchTheme.accent.opacity(0.68)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            if isGeneralWatchlist {
                generalWatchlistStrip
            } else {
                defaultPosterStack
            }
        }
    }

    private var defaultPosterStack: some View {
        let posterWidth: CGFloat = 100
        let posterHeight = posterWidth * 1.52

        return HStack(spacing: -posterWidth * 0.22) {
            ForEach(Array(list.previewTitles.prefix(3).enumerated()), id: \.element.id) { index, title in
                PosterImageView(
                    url: title.watchlistArtworkURL,
                    width: posterWidth,
                    height: posterHeight,
                    cornerRadius: 12
                )
                .rotationEffect(.degrees(Double(index - 1) * 6))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .padding(.horizontal, 12)
        .clipped()
    }

    private var generalWatchlistStrip: some View {
        let posterWidth = generalWatchlistPosterWidth
        let posterHeight = posterWidth * 1.52

        return HStack(spacing: -posterWidth * 0.34) {
            ForEach(Array(list.previewTitles.prefix(10).enumerated()), id: \.offset) { _, title in
                PosterImageView(
                    url: title.watchlistArtworkURL,
                    width: posterWidth,
                    height: posterHeight,
                    cornerRadius: 10
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .clipped()
    }
}

struct WatchlistSecureCoverImage<Placeholder: View>: View {
    let storagePath: String
    let fallbackURL: URL?
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var loadedImage: UIImage?
    @State private var isLoading = false

    var body: some View {
        Group {
            if let loadedImage {
                Image(uiImage: loadedImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else if let fallbackURL {
                CachedAsyncImage(url: fallbackURL) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    default:
                        placeholder()
                    }
                }
            } else {
                placeholder()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipped()
        .task(id: storagePath) {
            await loadImageIfNeeded()
        }
    }

    private func loadImageIfNeeded() async {
        guard !storagePath.isEmpty, loadedImage == nil, !isLoading else { return }

        isLoading = true
        defer { isLoading = false }

        do {
            let reference = Storage.storage().reference(withPath: storagePath)
            let data = try await reference.data(maxSize: 6 * 1024 * 1024)
            guard let image = downsampledImage(from: data) ?? UIImage(data: data) else { return }
            loadedImage = image
        } catch {
            // Keep the fallback visible if the authenticated Storage fetch fails.
        }
    }

    private func downsampledImage(from data: Data, maxPixelSize: CGFloat = 1800) -> UIImage? {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options) else { return nil }
        let thumbnailOptions = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(maxPixelSize)
        ] as CFDictionary
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
