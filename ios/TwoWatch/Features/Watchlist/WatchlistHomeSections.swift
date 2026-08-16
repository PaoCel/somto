import Foundation
import SwiftUI

// MARK: - Provider logos (chip / group header / badge)

/// Logo piccolo per una piattaforma streaming, con fallback testuale se il logo
/// non è ancora denormalizzato per quel titolo (copertura graduale via enrichment
/// on-demand + backfill). `accessibilityLabel` è sempre il nome della piattaforma,
/// mai il testo del fallback, cosi la lettura VoiceOver resta stabile.
struct WatchlistProviderLogoView: View {
    let name: String
    let logoURL: URL?
    var height: CGFloat = 16
    var textColor: Color = TwoWatchTheme.textPrimary

    var body: some View {
        Group {
            if let logoURL {
                CachedAsyncImage(url: logoURL) { phase in
                    switch phase {
                    case let .success(image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                    case .empty:
                        ProgressView()
                            .tint(textColor)
                    case .failure:
                        fallbackText
                    @unknown default:
                        fallbackText
                    }
                }
                .frame(height: height)
                .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            } else {
                fallbackText
            }
        }
        .accessibilityLabel(name)
    }

    private var fallbackText: some View {
        Text(name)
            .font(.caption2.weight(.bold))
            .foregroundStyle(textColor)
            .lineLimit(1)
    }
}

// MARK: - Watchlist top chrome (menu + wordmark + search + plus)

struct WatchlistChromeBar: View {
    var wordmarkWidth: CGFloat = 130
    var buttonSize: CGFloat = 38
    let onMenuTap: () -> Void
    let onSearchTap: () -> Void
    let onAddTap: () -> Void

    var body: some View {
        ZStack {
            BrandWordmarkView(width: wordmarkWidth)

            HStack(spacing: 0) {
                chromeButton(systemName: "line.3.horizontal", label: "Apri menu", action: onMenuTap)
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    chromeButton(systemName: "magnifyingglass", label: "Apri ricerca", action: onSearchTap)
                    plusButton
                }
            }
        }
        .frame(height: buttonSize)
    }

    private func chromeButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.headline.weight(.bold))
                .foregroundStyle(Color.black)
                .frame(width: buttonSize, height: buttonSize)
                .background(Color.black.opacity(0.05), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var plusButton: some View {
        Button(action: onAddTap) {
            Image(systemName: "plus")
                .font(.headline.weight(.heavy))
                .foregroundStyle(Color.white)
                .frame(width: buttonSize, height: buttonSize)
                .background(Color.black, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Crea lista")
    }
}

// MARK: - Quick ideas result sheet

struct WatchlistQuickIdeasSheet: View {
    let idea: WatchlistQuickIdeaKind
    let states: [TitlePersonalState]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let genreLookup: [String: String]
    let onClose: () -> Void
    let onOpenSearch: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header

                if states.isEmpty {
                    EmptyStateView(
                        title: "Niente ancora qui",
                        message: LocalizedStringKey(emptyMessage),
                        systemImage: idea.symbolName,
                        actionTitle: "Esplora titoli",
                        action: onOpenSearch
                    )
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(states) { state in
                            WatchlistCompactToWatchRow(
                                state: state,
                                container: container,
                                session: session,
                                shell: shell,
                                genreLookup: genreLookup
                            )
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .background(TwoWatchBackground())
        .navigationTitle(idea.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Chiudi", action: onClose)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.accent)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: idea.symbolName)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                    .frame(width: 40, height: 40)
                    .background(TwoWatchTheme.accent.opacity(0.16), in: Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text(idea.title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text(idea.subtitle)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                }
            }

            if !states.isEmpty {
                Text("\(states.count) titoli dalla tua lista")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .padding(.top, 4)
            }
        }
        .padding(.top, 12)
    }

    private var emptyMessage: String {
        switch idea {
        case .underTwoHours:
            return String(localized: "Aggiungi qualche titolo breve alla watchlist (film sotto le 2h o brevi serie) e li troverai qui.")
        case .fromCircle:
            return String(localized: "Quando una lista condivisa con i tuoi amici si sovrappone alla tua watchlist, i suggerimenti compaiono qui.")
        case .watchTogether:
            return String(localized: "Ci servono titoli con un voto community alto e durata accessibile per consigliarli per una serata insieme.")
        }
    }
}

// MARK: - Section B: Da vedere compact

struct WatchlistCompactToWatchSection: View {
    let states: [TitlePersonalState]
    let hasMore: Bool
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let genreLookup: [String: String]
    let onSeeAll: () -> Void
    let onOpenSearch: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 8) {
                    Image(systemName: "bookmark.fill")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                    Text("Da vedere")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }

                Spacer(minLength: 0)

                if hasMore {
                    Button("Vedi tutto", action: onSeeAll)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.accent)
                }
            }

            if states.isEmpty {
                EmptyStateView(
                    title: "Nessun titolo da vedere",
                    message: "Quando salvi un film o una serie non ancora vista, lo ritrovi qui.",
                    systemImage: "bookmark.slash.fill",
                    actionTitle: "Esplora titoli",
                    action: onOpenSearch
                )
            } else {
                VStack(spacing: 10) {
                    ForEach(states) { state in
                        WatchlistCompactToWatchRow(
                            state: state,
                            container: container,
                            session: session,
                            shell: shell,
                            genreLookup: genreLookup
                        )
                    }
                }
            }
        }
    }
}

struct WatchlistCompactToWatchRow: View {
    let state: TitlePersonalState
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    var genreLookup: [String: String] = [:]

    var body: some View {
        NavigationLink {
            TitleDetailView(container: container, session: session, shell: shell, titleID: state.titleId)
        } label: {
            HStack(alignment: .center, spacing: 12) {
                PosterImageView(
                    url: state.title?.posterPath ?? state.title?.backdropPath,
                    width: 56,
                    height: 80,
                    cornerRadius: 10
                )

                VStack(alignment: .leading, spacing: 6) {
                    Text(state.title?.name ?? state.titleId)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .lineLimit(1)

                    HStack(spacing: 8) {
                        compactChip(text: state.mediaType == .movie ? "Film" : "Serie", tint: TwoWatchTheme.accent)
                        if let meta = primaryMetaText {
                            Text(meta)
                                .font(.caption)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                        }
                    }

                    if let rating = ratingValue {
                        HStack(spacing: 4) {
                            Image(systemName: "star.fill")
                                .font(.caption2)
                                .foregroundStyle(TwoWatchTheme.accent)
                            Text(rating)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.accent)
                                .monospacedDigit()
                            if let genres = genresText {
                                Text(genres)
                                    .font(.caption)
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                    .lineLimit(1)
                            }
                        }
                    } else if let genres = genresText {
                        Text(genres)
                            .font(.caption)
                            .foregroundStyle(TwoWatchTheme.textMuted)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 0)

                // "i" decorativo — l'intera riga è il NavigationLink, tasto non separato
                Image(systemName: "info.circle")
                    .font(.headline)
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .accessibilityHidden(true)
            }
            .padding(12)
            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(state.title?.name ?? state.titleId), apri scheda")
    }

    private var ratingValue: String? {
        guard let rating = state.title?.ratingAvg, rating > 0 else { return nil }
        return String(format: "%.1f", rating)
    }

    private var primaryMetaText: String? {
        var parts: [String] = []
        if let year = state.title?.year { parts.append(String(year)) }
        switch state.mediaType {
        case .movie:
            if let dur = state.title?.metadata.durationMovie, dur > 0 {
                let h = dur / 60
                let m = dur % 60
                parts.append(h > 0 ? "\(h)h \(String(format: "%02d", m))m" : "\(m)m")
            }
        case .tv:
            if let seasons = state.title?.metadata.seasonsCount, seasons > 0 {
                parts.append(String(localized: "\(seasons) stagioni"))
            }
        }
        let joined = parts.joined(separator: " · ")
        return joined.isEmpty ? nil : joined
    }

    private var genresText: String? {
        guard let title = state.title else { return nil }
        let resolved = title.genres.compactMap { raw -> String? in
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { return nil }
            // Strip "tmdb_" prefix and look up the human label
            let key: String
            if trimmed.hasPrefix("tmdb_") {
                key = String(trimmed.dropFirst("tmdb_".count))
            } else {
                key = trimmed
            }
            if let mapped = genreLookup[key], !mapped.isEmpty {
                return mapped
            }
            // Fall back to the raw label only if it's not a numeric tmdb id
            return trimmed.hasPrefix("tmdb_") || Int(trimmed) != nil ? nil : trimmed
        }
        guard !resolved.isEmpty else { return nil }
        return resolved.prefix(2).joined(separator: ", ")
    }

    private func compactChip(text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.16), in: Capsule())
    }
}

// MARK: - Section C: Condivise (highlight cards)

struct WatchlistSharedHighlightsSection: View {
    let lists: [UserListSummary]
    let onSeeAll: () -> Void
    let onOpenList: (UserListSummary) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                HStack(spacing: 8) {
                    Image(systemName: "person.2.fill")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.accent)
                    Text("Condivise")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }

                Spacer(minLength: 0)

                Button("Vedi tutte", action: onSeeAll)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.accent)
            }

            if lists.isEmpty {
                EmptyStateView(
                    title: "Nessuna lista condivisa",
                    message: "Crea o accetta una lista condivisa per vederla qui.",
                    systemImage: "person.2.slash.fill"
                )
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(lists) { list in
                            WatchlistSharedHighlightCard(list: list) {
                                onOpenList(list)
                            }
                        }
                    }
                    .padding(.horizontal, 1)
                }
                .scrollClipDisabled()
            }
        }
    }
}

private struct WatchlistSharedHighlightCard: View {
    let list: UserListSummary
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 10) {
                collageGrid
                    .frame(width: 200, height: 200)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )

                Text(list.title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(1)

                Text("\(list.itemCount) titoli")
                    .font(.caption)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .frame(width: 200)
        }
        .buttonStyle(.plain)
    }

    private var collageGrid: some View {
        let urls: [URL] = list.previewTitles.compactMap { $0.posterPath ?? $0.backdropPath }
        return ZStack {
            if urls.isEmpty {
                LinearGradient(
                    colors: [TwoWatchTheme.brandSecondary.opacity(0.45), TwoWatchTheme.accent.opacity(0.35)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                Image(systemName: "person.2.fill")
                    .font(.system(size: 32, weight: .bold))
                    .foregroundStyle(.white.opacity(0.6))
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 1), GridItem(.flexible(), spacing: 1)], spacing: 1) {
                    ForEach(0 ..< 4, id: \.self) { i in
                        if i < urls.count {
                            CachedAsyncImage(url: urls[i]) { phase in
                                switch phase {
                                case .empty:
                                    Color.black.opacity(0.5)
                                case .success(let image):
                                    image.resizable().scaledToFill()
                                case .failure:
                                    Color.black.opacity(0.5)
                                @unknown default:
                                    Color.black.opacity(0.5)
                                }
                            }
                            .frame(width: 100, height: 100)
                            .clipped()
                        } else {
                            Color.black.opacity(0.4)
                                .frame(width: 100, height: 100)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Section D: Idee rapide per te

enum WatchlistQuickIdeaKind: String, CaseIterable, Identifiable {
    case underTwoHours
    case fromCircle
    case watchTogether

    var id: String { rawValue }

    var title: String {
        switch self {
        case .underTwoHours: return String(localized: "Sotto le 2 ore")
        case .fromCircle: return String(localized: "Dalla tua cerchia")
        case .watchTogether: return "Da guardare insieme"
        }
    }

    var subtitle: String {
        switch self {
        case .underTwoHours: return "Film e serie veloci da finire stasera"
        case .fromCircle: return String(localized: "Scelti da amici e persone che segui")
        case .watchTogether: return String(localized: "Titoli perfetti per una serata")
        }
    }

    var symbolName: String {
        switch self {
        case .underTwoHours: return "clock.fill"
        case .fromCircle: return "person.2.fill"
        case .watchTogether: return "heart.fill"
        }
    }
}

struct WatchlistQuickIdeasSection: View {
    let onPickQuickIdea: (WatchlistQuickIdeaKind) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.accent)
                Text("Idee rapide per te")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(WatchlistQuickIdeaKind.allCases) { idea in
                        Button {
                            onPickQuickIdea(idea)
                        } label: {
                            HStack(alignment: .center, spacing: 12) {
                                Image(systemName: idea.symbolName)
                                    .font(.headline)
                                    .foregroundStyle(TwoWatchTheme.accent)
                                    .frame(width: 36, height: 36)
                                    .background(TwoWatchTheme.accent.opacity(0.16), in: Circle())
                                    .accessibilityHidden(true) // decorativo, testo già leggibile

                                VStack(alignment: .leading, spacing: 3) {
                                    Text(idea.title)
                                        .font(.subheadline.weight(.bold))
                                        .foregroundStyle(TwoWatchTheme.textPrimary)
                                    Text(idea.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(TwoWatchTheme.textSecondary)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                }

                                Spacer(minLength: 4)

                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(TwoWatchTheme.textMuted)
                                    .accessibilityHidden(true) // decorativo
                            }
                            .padding(12)
                            .frame(width: 240)
                            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .stroke(TwoWatchTheme.border, lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(idea.title): \(idea.subtitle)")
                    }
                }
                .padding(.horizontal, 1)
            }
            .scrollClipDisabled()
        }
    }
}

// MARK: - Section: "Stasera guardi?" hero deck

/// Moodboard: `design/watchlist-redesign/somto-watchlist-ios-redesign.html` (solo
/// forma — deck impilato, scrim, chip). Palette/typography restano TwoWatchTheme,
/// nessun font/colore custom del mockup.
///
/// Deck di max 3 card da `dashboard.generalWatchlist.slice(0,3)`, nessuna nuova
/// query. "Non stasera" avanza l'indice ciclicamente (nessuna scrittura). Il
/// chiamante nasconde la sezione quando `generalWatchlist` è vuota (zero spazio
/// orfano) — qui assumiamo `states` non vuoto.
struct WatchlistTonightHeroSection: View {
    let states: [TitlePersonalState]
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    @State private var heroIndex = 0

    private var deck: [TitlePersonalState] {
        // Mostriamo fino a 10 titoli nel deck (prima erano 3): l'utente può
        // scorrerne di più con "Non stasera"/swipe. Lo stack visibile resta di 3
        // card (gate `rel < 3` sotto), quindi il layout non cambia.
        Array(states.prefix(10))
    }

    var body: some View {
        let deck = deck
        if !deck.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Dalla tua watchlist")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .textCase(.uppercase)
                    Text("Cosa vuoi guardare oggi?")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                }

                ZStack {
                    ForEach(Array(deck.enumerated()), id: \.element.id) { offset, state in
                        let rel = (offset - heroIndex + deck.count) % deck.count
                        if rel < 3 {
                            WatchlistTonightHeroCard(
                                state: state,
                                container: container,
                                session: session,
                                shell: shell,
                                isFront: rel == 0,
                                onSkip: advance
                            )
                            .zIndex(Double(deck.count - rel))
                            .offset(y: CGFloat(rel) * 10)
                            .scaleEffect(1 - (CGFloat(rel) * 0.04), anchor: .top)
                            .opacity(rel < 3 ? 1 : 0)
                            .allowsHitTesting(rel == 0)
                        }
                    }
                }
                .frame(height: 372)

                if deck.count > 1 {
                    HStack(spacing: 5) {
                        ForEach(Array(deck.enumerated()), id: \.element.id) { offset, _ in
                            Capsule()
                                .fill(offset == heroIndex ? TwoWatchTheme.accent : TwoWatchTheme.border)
                                .frame(width: offset == heroIndex ? 16 : 6, height: 6)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
                }
            }
            .onChange(of: states.count) { _, _ in
                if heroIndex >= deck.count { heroIndex = 0 }
            }
        }
    }

    private func advance() {
        guard !deck.isEmpty else { return }
        withAnimation(.easeInOut(duration: 0.22)) {
            heroIndex = (heroIndex + 1) % deck.count
        }
    }
}

private struct WatchlistTonightHeroCard: View {
    let state: TitlePersonalState
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    let isFront: Bool
    let onSkip: () -> Void

    @State private var dragOffset: CGSize = .zero
    @State private var showsDetail = false
    /// Soglia di swipe orizzontale oltre la quale la card viene "scartata"
    /// (equivalente a "Non stasera").
    private let dismissThreshold: CGFloat = 80

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            posterLayer

            LinearGradient(
                colors: [Color.clear, Color.black.opacity(0.62), Color.black.opacity(0.95)],
                startPoint: .top,
                endPoint: .bottom
            )

            VStack(alignment: .leading, spacing: 10) {
                Spacer(minLength: 0)

                Text(chipText)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.white.opacity(0.22), in: Capsule())

                Text(state.title?.name ?? state.titleId)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                    .fixedSize(horizontal: false, vertical: true)

                if let meta = metaText {
                    HStack(spacing: 6) {
                        Text(meta)
                        if let rating = ratingText {
                            Circle().fill(.white.opacity(0.6)).frame(width: 3, height: 3)
                            Text("★ \(rating)")
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.85))
                }

                if isFront {
                    // Solo "Non stasera": la card intera è tappabile per aprire il
                    // titolo (onTapGesture sotto), niente più pulsante dedicato
                    // ridondante — evita anche il pitfall SwiftUI di un Button
                    // annidato dentro la label di un NavigationLink.
                    Button(action: onSkip) {
                        Text("Non stasera")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(Color.white.opacity(0.16), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Non stasera, mostra un altro titolo")
                    .padding(.top, 2)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 372)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
        .offset(x: dragOffset.width, y: dragOffset.height * 0.15)
        .rotationEffect(.degrees(Double(dragOffset.width / 20)))
        .contentShape(Rectangle())
        .onTapGesture {
            guard isFront else { return }
            showsDetail = true
        }
        // simultaneousGesture (non .gesture): con .gesture, DragGesture diventa
        // "attivo" al primo movimento e può ritardare il riconoscimento del pan
        // della ScrollView — il dito che parte sulla card gigante non riusciva
        // più a scrollare la pagina. In simultaneo entrambi i gesture tracciano
        // il drag; onChanged applica l'offset SOLO se chiaramente orizzontale
        // (isHorizontalDrag, soglia 1.5x non solo "maggiore di"), e minimumDistance
        // alto (24) dà alla ScrollView un vantaggio nel reclamare per prima i drag
        // verticali/ambigui. Stesso guard anche in onEnded, altrimenti un fling
        // verticale con una componente orizzontale >80pt scartava comunque la
        // card pur non avendola mai spostata visivamente durante il drag.
        .simultaneousGesture(isFront ? dragGesture : nil)
        .onChange(of: isFront) { _, front in
            // Quando la card non è più in cima (indice avanzato) azzera lo stato
            // di trascinamento, così quando torna in cima riparte pulita.
            if !front { dragOffset = .zero }
        }
        .navigationDestination(isPresented: $showsDetail) {
            TitleDetailView(container: container, session: session, shell: shell, titleID: state.titleId)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary)
        .accessibilityAddTraits(.isButton)
    }

    private func isHorizontalDrag(_ value: DragGesture.Value) -> Bool {
        abs(value.translation.width) > abs(value.translation.height) * 1.5
    }

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { value in
                guard isHorizontalDrag(value) else { return }
                dragOffset = value.translation
            }
            .onEnded { value in
                guard isHorizontalDrag(value), abs(value.translation.width) > dismissThreshold else {
                    // Sotto soglia, o drag non chiaramente orizzontale: ritorno elastico.
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                        dragOffset = .zero
                    }
                    return
                }
                // Oltre soglia: la card prosegue fuori schermo nella direzione
                // dello swipe, poi il deck avanza (stesso effetto di "Non
                // stasera"). Il reset dell'offset avviene quando la card non è
                // più frontale (vedi onChange(of: isFront)), dietro alle altre.
                let direction: CGFloat = value.translation.width > 0 ? 1 : -1
                withAnimation(.easeOut(duration: 0.18)) {
                    dragOffset = CGSize(width: direction * 520, height: value.translation.height)
                }
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 180_000_000)
                    onSkip()
                    // Con deck da 1 titolo la card resta frontale: riportala
                    // in posizione. Negli altri casi l'offset è già stato
                    // azzerato da onChange(of: isFront) → no-op.
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                        dragOffset = .zero
                    }
                }
            }
    }

    @ViewBuilder
    private var posterLayer: some View {
        if let url = state.title?.posterPath ?? state.title?.backdropPath {
            CachedAsyncImage(url: url) { phase in
                switch phase {
                case let .success(image):
                    image.resizable().scaledToFill()
                default:
                    TwoWatchTheme.brandGradient
                }
            }
        } else {
            TwoWatchTheme.brandGradient
        }
    }

    private var chipText: String {
        state.mediaType == .movie ? "Film" : "Serie TV"
    }

    private var ratingText: String? {
        guard let rating = state.title?.ratingAvg, rating > 0 else { return nil }
        return String(format: "%.1f", rating)
    }

    private var metaText: String? {
        var parts: [String] = []
        if let year = state.title?.year { parts.append(String(year)) }
        switch state.mediaType {
        case .movie:
            if let dur = state.title?.metadata.durationMovie, dur > 0 {
                let h = dur / 60
                let m = dur % 60
                parts.append(h > 0 ? "\(h)h \(String(format: "%02d", m))m" : "\(m)m")
            }
        case .tv:
            if let seasons = state.title?.metadata.seasonsCount, seasons > 0 {
                parts.append(String(localized: "\(seasons) stagioni"))
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var accessibilitySummary: String {
        var summary = state.title?.name ?? state.titleId
        if let meta = metaText { summary += ", \(meta)" }
        if let rating = ratingText { summary += ", voto community \(rating)" }
        return summary
    }
}

// MARK: - Section: tip creazione liste + preset (area Condivise)

/// Dismiss persistito in `UserDefaults`, pattern `MatchHintService`: solo dismiss
/// manuale (niente auto-hide/scadenza), un flag booleano.
@Observable
@MainActor
final class WatchlistCreateListTipService {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var isDismissed: Bool {
        defaults.bool(forKey: SomtoDefaultsKey.watchlistCreateTipDismissed)
    }

    func dismiss() {
        defaults.set(true, forKey: SomtoDefaultsKey.watchlistCreateTipDismissed)
    }
}

// MARK: - Welcome card (area Home)

/// Messaggio di benvenuto in cima alla Home della watchlist, dismissibile.
/// Stesso pattern di `WatchlistCreateListTipService` (flag booleano in UserDefaults).
@Observable
@MainActor
final class WatchlistWelcomeService {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var isDismissed: Bool {
        defaults.bool(forKey: SomtoDefaultsKey.watchlistWelcomeDismissed)
    }

    func dismiss() {
        defaults.set(true, forKey: SomtoDefaultsKey.watchlistWelcomeDismissed)
    }
}

struct WatchlistWelcomeCard: View {
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Benvenuto nella tua watchlist 👋")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)

                    Text("Qui trovi tutto quello che vuoi vedere: la lista generale raccoglie ogni titolo salvato, e puoi creare liste personalizzate — anche condivise con gli amici.")
                        .font(.subheadline)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .frame(width: 28, height: 28)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Chiudi il messaggio di benvenuto")
            }

            HStack {
                Spacer(minLength: 0)
                Button(action: onDismiss) {
                    Text("Non mostrare più")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Non mostrare più il messaggio di benvenuto")
            }
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

/// Preset che pre-compila SOLO nome + kind + visibility del nuovo `UserListEditorDraft`
/// (il modello dati non ha filtri per media-type: niente da inventare qui).
struct WatchlistListPreset: Identifiable, Hashable {
    let id: String
    let label: String
    let title: String
    let kind: UserListKind
    let visibility: UserListVisibility

    static let filmList = WatchlistListPreset(
        id: "film",
        label: "+ Lista Film",
        title: "Lista Film",
        kind: .collection,
        visibility: .private
    )
    static let seriesList = WatchlistListPreset(
        id: "series",
        label: "+ Lista Serie TV",
        title: "Lista Serie TV",
        kind: .collection,
        visibility: .private
    )
    static let path = WatchlistListPreset(
        id: "path",
        label: "+ Percorso/Maratona",
        title: "Percorso/Maratona",
        kind: .orderedPath,
        visibility: .private
    )
    static let withFriends = WatchlistListPreset(
        id: "friends",
        label: String(localized: "+ Con amici"),
        title: String(localized: "Con amici"),
        kind: .collection,
        visibility: .shared
    )

    static let all: [WatchlistListPreset] = [.filmList, .seriesList, .path, .withFriends]
}

struct WatchlistCreateListTip: View {
    let onDismiss: () -> Void
    let onPickPreset: (WatchlistListPreset) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Text("Puoi creare liste per genere, maratone o serate con amici: scegli un punto di partenza o parti da zero.")
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 8)

                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .frame(width: 28, height: 28)
                        .background(TwoWatchTheme.panelStrong, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Chiudi suggerimento")
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(WatchlistListPreset.all) { preset in
                        Button {
                            onPickPreset(preset)
                        } label: {
                            Text(preset.label)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(TwoWatchTheme.textPrimary)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 9)
                                .background(TwoWatchTheme.panelStrong, in: Capsule())
                                .overlay(
                                    Capsule().stroke(TwoWatchTheme.border, lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 1)
            }
            // NIENTE .scrollClipDisabled() qui: il carosello di chip vive dentro
            // la card (padding 14 + bordo arrotondato). Con il clip disabilitato
            // le chip sbordavano oltre il bordo della card. Clippando allo scroll
            // restano dentro la card.
        }
        .padding(14)
        .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(TwoWatchTheme.border, lineWidth: 1)
        )
    }
}

/// Modale esplicativo mostrato una sola volta al primo ingresso in Watchlist.
/// Chiarisce la differenza tra watchlist (cosa vuoi vedere) e liste
/// personalizzate (raccolte a tema, che possono contenere anche titoli già
/// visti) e indica dove ritrovare i visti: Profilo → filtro Serie TV / Film.
struct WatchlistIntroSheet: View {
    let onGoToProfile: () -> Void
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Come funziona la Watchlist")
                            .font(.title2.weight(.black))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Due minuti per non perderti nulla.")
                            .font(.subheadline)
                            .foregroundStyle(TwoWatchTheme.textSecondary)
                    }

                    VStack(spacing: 14) {
                        introRow(
                            icon: "bookmark.fill",
                            tint: TwoWatchTheme.accent,
                            title: "Qui metti cosa vuoi vedere",
                            text: String(localized: "La watchlist è la tua coda: film e serie che vuoi guardare, con il punto a cui sei arrivato nelle serie in corso.")
                        )
                        introRow(
                            icon: "rectangle.stack.fill",
                            tint: TwoWatchTheme.brandPrimary,
                            title: String(localized: "Le liste personalizzate tengono tutto"),
                            text: String(localized: "Una lista che crei tu è una raccolta a tema: può contenere anche titoli che hai già visto, non solo cose da vedere.")
                        )
                        introRow(
                            icon: "person.crop.circle.fill",
                            tint: TwoWatchTheme.brandWarm,
                            title: String(localized: "Cosa hai già visto? Vai nel Profilo"),
                            text: String(localized: "Per rivedere tutto quello che hai guardato apri il Profilo e filtra per \u{201C}Serie TV\u{201D} o \u{201C}Film\u{201D}.")
                        )
                    }

                    VStack(spacing: 10) {
                        Button(action: onGoToProfile) {
                            Text("Vai al profilo")
                                .font(.headline.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 15)
                                .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        .buttonStyle(.plain)

                        Button("Ho capito", action: onClose)
                            .buttonStyle(TitleOutlineButtonStyle(tint: TwoWatchTheme.textSecondary))
                    }
                    .padding(.top, 4)
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(TwoWatchBackground())
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                    }
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .accessibilityLabel("Chiudi")
                }
            }
        }
    }

    private func introRow(icon: String, tint: Color, title: String, text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.title3.weight(.bold))
                .foregroundStyle(tint)
                .frame(width: 44, height: 44)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Tutta la watchlist (entrata esplicita alla coda intera)

/// Card che porta alla griglia con tutta la coda. Gli scaffali della Home
/// rispondono a domande specifiche ("cosa riprendo", "cosa ci sta stasera"):
/// senza questa card la lista completa non ha una porta visibile.
struct WatchlistAllEntryCard: View {
    let states: [TitlePersonalState]
    let onOpen: () -> Void

    private var posterURLs: [URL] {
        states.compactMap { $0.title?.posterPath }.prefix(6).map { $0 }
    }

    private var savedTitlesSummary: String {
        if states.count == 1 {
            return String(localized: "1 titolo salvato · cerca, filtra, ordina")
        }
        return String(
            format: String(localized: "%lld titoli salvati · cerca, filtra, ordina"),
            locale: .current,
            states.count
        )
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 14) {
                if !posterURLs.isEmpty {
                    HStack(spacing: -18) {
                        ForEach(Array(posterURLs.enumerated()), id: \.offset) { index, url in
                            CachedAsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let image):
                                    image.resizable().scaledToFill()
                                default:
                                    Color.white.opacity(0.06)
                                }
                            }
                            .frame(width: 30, height: 45)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .stroke(Color.black.opacity(0.85), lineWidth: 1.5)
                            )
                            .zIndex(Double(posterURLs.count - index))
                        }
                    }
                    .fixedSize()
                }

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Image(systemName: "bookmark.fill")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.brandPrimary)
                        Text("Tutta la watchlist")
                            .font(.headline.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                    }
                    Text(savedTitlesSummary)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textSecondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                TwoWatchTheme.brandWarm.opacity(0.16),
                                TwoWatchTheme.brandPrimary.opacity(0.16),
                                TwoWatchTheme.brandSecondary.opacity(0.16),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TwoWatchTheme.brandPrimary.opacity(0.3), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Tutta la watchlist"))
    }
}

// MARK: - Liste: pill visibilità + riga compatta

/// Pill "Privata / Con amici / Pubblica". Rende leggibile a colpo d'occhio chi
/// vede una lista, che era l'informazione mancante nella vecchia schermata.
struct WatchlistVisibilityPill: View {
    let visibility: UserListVisibility

    private var label: String {
        switch visibility {
        case .private: return String(localized: "Privata")
        case .shared: return String(localized: "Con amici")
        case .public: return String(localized: "Pubblica")
        }
    }

    private var symbol: String {
        switch visibility {
        case .private: return "lock.fill"
        case .shared: return "person.2.fill"
        case .public: return "globe"
        }
    }

    private var tint: Color {
        switch visibility {
        case .private: return TwoWatchTheme.textSecondary
        case .shared: return TwoWatchTheme.brandSecondary
        case .public: return TwoWatchTheme.accent
        }
    }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
                .font(.system(size: 9, weight: .bold))
            Text(label)
                .font(.system(size: 11, weight: .bold))
        }
        .foregroundStyle(visibility == .private ? tint : tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
            Capsule().fill(tint.opacity(visibility == .private ? 0.12 : 0.18))
        )
        .overlay(Capsule().stroke(tint.opacity(0.4), lineWidth: 1))
    }
}

/// Copertina a mosaico 2x2 dai poster della lista.
struct WatchlistListMosaic: View {
    let titles: [Title]
    var side: CGFloat = 54

    var body: some View {
        let urls = titles.prefix(4).compactMap { $0.posterPath }
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 1), GridItem(.flexible(), spacing: 1)], spacing: 1) {
            ForEach(0 ..< 4, id: \.self) { i in
                if i < urls.count {
                    CachedAsyncImage(url: urls[i]) { phase in
                        switch phase {
                        case .success(let image): image.resizable().scaledToFill()
                        default: Color.white.opacity(0.06)
                        }
                    }
                    .frame(width: side / 2, height: side / 2)
                    .clipped()
                } else {
                    Color.white.opacity(0.06)
                        .frame(width: side / 2, height: side / 2)
                }
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// Riga di una lista: copertina, nome, quanti titoli e quanti visti, chi la vede.
/// Sostituisce `WatchlistLibraryListRow` nella schermata liste: niente bottoni
/// dentro la riga, niente chip sovrapposte alla copertina.
struct WatchlistListsRow: View {
    let list: UserListSummary
    var showsOwner: Bool = false
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                WatchlistListMosaic(titles: list.previewTitles)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(list.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(1)
                        if list.kind == .orderedPath {
                            HStack(spacing: 2) {
                                Image(systemName: "arrow.triangle.turn.up.right.diamond.fill")
                                    .font(.system(size: 9))
                                Text("in ordine")
                                    .font(.system(size: 11, weight: .semibold))
                            }
                            .foregroundStyle(TwoWatchTheme.textMuted)
                        }
                    }

                    Text(subtitleText)
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .lineLimit(1)

                    HStack(spacing: 6) {
                        WatchlistVisibilityPill(visibility: list.visibility)
                        if showsOwner, let owner = list.owner?.displayName, !list.isOwnedByCurrentUser {
                            Text("di \(owner)")
                                .font(.system(size: 11))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }
                        if list.followersCount > 0 {
                            Text("\(list.followersCount) follower")
                                .font(.system(size: 11))
                                .foregroundStyle(TwoWatchTheme.textMuted)
                        }
                    }

                    if list.itemCount > 0 {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.white.opacity(0.12))
                                Capsule()
                                    .fill(TwoWatchTheme.brandPrimary)
                                    .frame(width: max(2, geo.size.width * list.progressFraction))
                            }
                        }
                        .frame(height: 3)
                        .padding(.top, 2)
                    }
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(TwoWatchTheme.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var subtitleText: String {
        guard list.itemCount > 0 else { return String(localized: "Vuota") }
        let titoli = list.itemCount == 1 ? "1 titolo" : "\(list.itemCount) titoli"
        return "\(titoli) · \(list.completedCount)/\(list.itemCount) visti"
    }
}

/// Riga d'ingresso al catalogo delle liste pubbliche. La discovery non deve
/// stare in mezzo alle liste dell'utente: una voce sola, in fondo.
struct WatchlistDiscoverListsRow: View {
    let count: Int
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(TwoWatchTheme.brandPrimary.opacity(0.16))
                    Image(systemName: "sparkle.magnifyingglass")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(TwoWatchTheme.brandPrimary)
                }
                .frame(width: 54, height: 54)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Scopri altre liste")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text(count > 0
                         ? (count == 1 ? String(localized: "1 lista pubblica da salvare") : "\(count) liste pubbliche da salvare")
                         : String(localized: "Liste pubbliche da salvare"))
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(TwoWatchTheme.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

/// Card di lista in griglia: copertina quadrata + nome + conteggi + visibilità.
/// Le righe a tutta larghezza sprecavano spazio e rendevano la schermata un
/// muro di testo; in griglia 3 colonne si legge come uno scaffale.
struct WatchlistListGridCard: View {
    let list: UserListSummary
    var showsOwner: Bool = false
    let onOpen: () -> Void

    private var countsText: String {
        guard list.itemCount > 0 else { return String(localized: "Vuota") }
        let titoli = list.itemCount == 1 ? "1 titolo" : "\(list.itemCount) titoli"
        return "\(titoli) · \(list.completedCount) visti"
    }

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 6) {
                ZStack(alignment: .bottomLeading) {
                    WatchlistListMosaic(titles: list.previewTitles, side: 112)

                    if list.itemCount > 0 {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Rectangle().fill(Color.black.opacity(0.55))
                                Rectangle()
                                    .fill(TwoWatchTheme.brandPrimary)
                                    .frame(width: max(2, geo.size.width * list.progressFraction))
                            }
                        }
                        .frame(height: 3)
                        .frame(maxWidth: .infinity, alignment: .bottom)
                    }
                }
                .frame(height: 112)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                Text(list.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(TwoWatchTheme.textPrimary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                Text(countsText)
                    .font(.system(size: 11))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .lineLimit(1)

                if showsOwner, !list.isOwnedByCurrentUser, let owner = list.owner?.displayName {
                    Text("di \(owner)")
                        .font(.system(size: 11))
                        .foregroundStyle(TwoWatchTheme.textMuted)
                        .lineLimit(1)
                } else {
                    WatchlistVisibilityPill(visibility: list.visibility)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }
}
