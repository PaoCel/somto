import SwiftUI

// Card e celle della Watchlist: griglia, header di sezione, scoperta,
// selettore d'area, card di stato del titolo. Estratte da WatchlistView.swift.

/// Badge "In uscita" per un titolo non ancora disponibile. La data arriva dalla
/// release italiana in `titleUpdateEvents`, la stessa che la scheda titolo
/// mostra sotto "In uscita": una frase sola per un concetto solo.
///
/// Due misure perché i due layout della watchlist hanno spazi diversi: la riga
/// ha posto per parola + data, la cella a griglia sta sopra un poster largo un
/// terzo di schermo e tiene solo l'icona e il giorno.
struct WatchlistUpcomingBadge: View {
    let date: Date
    /// Variante da poster: capsula scura come gli altri badge sovrapposti.
    var isCompact = false

    var body: some View {
        HStack(spacing: SomtoSpacing.xs) {
            Image(systemName: "calendar")
                .font(.caption2.weight(.bold))

            if !isCompact {
                Text("In uscita")
                    .font(.caption2.weight(.black))
            }

            Text(date, format: yearAwareDateStyle)
                .font(.caption2.weight(.bold))
                .monospacedDigit()
        }
        .lineLimit(1)
        .foregroundStyle(isCompact ? Color.white : TwoWatchTheme.accent)
        .padding(.horizontal, isCompact ? SomtoSpacing.s : SomtoSpacing.m)
        .padding(.vertical, isCompact ? SomtoSpacing.xs : SomtoSpacing.s)
        .background(
            isCompact
                ? AnyShapeStyle(Color.black.opacity(0.62))
                : AnyShapeStyle(TwoWatchTheme.accent.opacity(0.14)),
            in: Capsule()
        )
        .accessibilityElement(children: .ignore)
        // Un'unica label invece di label + value: le card la combinano con il
        // resto della riga (`children: .combine`), e in quella combinazione il
        // value andrebbe perso.
        .accessibilityLabel(Text("In uscita") + Text(verbatim: " ") + Text(date, format: Self.fullDateStyle))
    }

    /// `effectiveAt` è una data di calendario ancorata a mezzogiorno UTC dal
    /// writer: formattarla nel fuso del device sposterebbe il giorno oltre
    /// UTC+12. Si fissa il fuso, non il locale — nomi dei mesi e ordine dei
    /// campi restano quelli dell'utente (§6.5 dello stile iOS).
    private static var fullDateStyle: Date.FormatStyle {
        Date.FormatStyle(timeZone: .gmt).day().month(.abbreviated).year()
    }

    /// L'anno si mostra solo quando serve a non fraintendere: un "8 ott" per un
    /// film del 2028 si legge come "fra poco". Vale in entrambi i layout — nella
    /// riga accanto c'è già la pill dell'anno, e ripeterlo ("2026" · "8 ott
    /// 2026") è rumore.
    private var yearAwareDateStyle: Date.FormatStyle {
        let calendar = Calendar.current
        let isThisYear = calendar.component(.year, from: date) == calendar.component(.year, from: Date())
        return isThisYear
            ? Date.FormatStyle(timeZone: .gmt).day().month(.abbreviated)
            : Date.FormatStyle(timeZone: .gmt).month(.abbreviated).year()
    }
}

struct WatchlistGridCell: View {
    let state: TitlePersonalState
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    var platformNames: [String] = []
    var platformLogos: [String: URL] = [:]
    var showPlatformBadge: Bool = true
    /// Data di uscita, se il titolo non è ancora uscito. Arriva già risolta dal
    /// ViewModel: la cella non interroga niente.
    var upcomingReleaseAt: Date?

    var body: some View {
        if let title = state.title {
            NavigationLink {
                TitleDetailView(container: container, session: session, shell: shell, titleID: title.id)
            } label: {
                VStack(alignment: .leading, spacing: 8) {
                    CachedAsyncImage(url: title.posterPath ?? title.backdropPath) { phase in
                        switch phase {
                        case let .success(image):
                            image.resizable().scaledToFill()
                        case .empty:
                            ZStack {
                                TwoWatchTheme.panelStrong
                                ProgressView()
                                    .tint(TwoWatchTheme.textSecondary)
                            }
                        default:
                            ZStack {
                                TwoWatchTheme.brandGradient
                                Image(systemName: "film.stack.fill")
                                    .font(.headline)
                                    .foregroundStyle(.white.opacity(0.82))
                            }
                        }
                    }
                    .aspectRatio(2/3, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(alignment: .topTrailing) {
                        if state.isCompleted {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption.weight(.black))
                                .foregroundStyle(.white)
                                .padding(5)
                                .background(TwoWatchTheme.success.opacity(0.92), in: Circle())
                                .padding(6)
                                .accessibilityLabel("Gia visto")
                        }
                    }
                    .overlay(alignment: .topLeading) {
                        if let upcomingReleaseAt {
                            WatchlistUpcomingBadge(date: upcomingReleaseAt, isCompact: true)
                                .padding(SomtoSpacing.s)
                        }
                    }
                    .overlay(alignment: .bottomLeading) {
                        if let rating = ownRatingText {
                            HStack(spacing: 3) {
                                Image(systemName: "star.fill")
                                    .font(.caption2.weight(.bold))
                                Text(rating)
                                    .font(.caption2.weight(.bold))
                                    .monospacedDigit()
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(Color.black.opacity(0.62), in: Capsule())
                            .padding(6)
                            .accessibilityLabel("Il tuo voto \(rating)")
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if showPlatformBadge, let platformText = watchlistPlatformBadgeText(platformNames) {
                            WatchlistPlatformBadgeContent(names: platformNames, logos: platformLogos, textColor: .white)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 4)
                                .background(Color.black.opacity(0.62), in: Capsule())
                                .padding(6)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("Disponibile su \(platformText)")
                        }
                    }
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .stroke(TwoWatchTheme.border, lineWidth: 1)
                    )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(title.name)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(TwoWatchTheme.textPrimary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)

                        if let meta = metaText {
                            Text(meta)
                                .font(.caption2)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .monospacedDigit()
                                .lineLimit(1)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Apri scheda titolo")
        }
    }

    private var ownRatingText: String? {
        guard let value = state.ratingValue, value > 0 else { return nil }
        return String(format: "%.1f", value)
    }

    private var metaText: String? {
        var parts: [String] = []
        if let year = state.title?.year { parts.append(String(year)) }
        switch state.mediaType {
        case .movie:
            if let dur = state.title?.metadata.durationMovie, dur > 0 {
                let h = dur / 60
                let m = dur % 60
                parts.append(h > 0 ? "\(h)h\(m > 0 ? " \(m)m" : "")" : "\(m)m")
            }
        case .tv:
            if let seasons = state.title?.metadata.seasonsCount, seasons > 0 {
                parts.append(String(localized: "\(seasons) stag."))
            }
        }
        let joined = parts.joined(separator: " · ")
        return joined.isEmpty ? nil : joined
    }
}

struct WatchlistSectionHeader: View {
    let title: String
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.title2.weight(.black))
                .foregroundStyle(TwoWatchTheme.textPrimary)
            Text(subtitle)
                .font(.subheadline)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Card "Scopri per te": porta il deck di Match (ora fuori dalla tab bar)
/// dentro la Watchlist. Spinge `WatchlistDiscoverForYouScreen` — che incapsula
/// `MatchView` — sullo stack della Watchlist.
struct WatchlistDiscoverForYouCard: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore

    var body: some View {
        NavigationLink {
            WatchlistDiscoverForYouScreen(
                container: container,
                session: session,
                shell: shell
            )
        } label: {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "rectangle.stack.fill")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 48, height: 48)
                    .background(TwoWatchTheme.brandGradient, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Scopri per te")
                        .font(.headline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                    Text("Titoli scelti dall'algoritmo, non ancora nella tua watchlist.")
                        .font(.caption)
                        .foregroundStyle(TwoWatchTheme.textSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 4)

                Image(systemName: "chevron.right")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(TwoWatchTheme.textMuted)
                    .accessibilityHidden(true)
            }
            .padding(14)
            .frame(maxWidth: .infinity)
            .background(TwoWatchTheme.panel, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(TwoWatchTheme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scopri per te")
        .accessibilityHint("Titoli scelti dall'algoritmo, non ancora nella tua watchlist")
    }
}

/// Wrapper di `MatchView` per l'accesso "Scopri per te" dalla Watchlist.
/// `MatchView` nasconde la sua navigation bar (`.toolbar(.hidden)`), quindi qui
/// mostriamo un titolo inline + un pulsante Indietro esplicito così l'utente
/// può tornare alla Watchlist.
struct WatchlistDiscoverForYouScreen: View {
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        MatchView(container: container, session: session, shell: shell)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack(spacing: 10) {
                    Button {
                        dismiss()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left")
                                .font(.subheadline.weight(.bold))
                            Text("Watchlist")
                                .font(.subheadline.weight(.semibold))
                        }
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(.ultraThinMaterial, in: Capsule())
                    }
                    .accessibilityLabel("Torna alla Watchlist")

                    Spacer()

                    Text("Scopri per te")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(TwoWatchTheme.textPrimary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 4)
            }
            .navigationBarBackButtonHidden(true)
    }
}

struct WatchlistAreaPicker: View {
    @Binding var selection: WatchlistArea

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(WatchlistArea.allCases) { area in
                        let isSelected = selection == area
                        Button {
                            withAnimation(.easeInOut(duration: 0.18)) { selection = area }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: area.symbolName)
                                    .font(.subheadline.weight(.semibold))
                                Text(area.rawValue)
                                    .font(.subheadline.weight(.semibold))
                            }
                            .foregroundStyle(isSelected ? Color.black : TwoWatchTheme.textPrimary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(
                                isSelected
                                    ? AnyShapeStyle(TwoWatchTheme.accent)
                                    : AnyShapeStyle(TwoWatchTheme.panelStrong),
                                in: Capsule()
                            )
                            .overlay(
                                Capsule()
                                    .stroke(isSelected ? Color.clear : TwoWatchTheme.border, lineWidth: 1)
                            )
                        }
                        .buttonStyle(.plain)
                        .id(area)
                        // Etichetta + trait selezione per VoiceOver
                        .accessibilityLabel(area.rawValue)
                        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
                    }
                }
                .padding(.horizontal, 1)
            }
            .scrollClipDisabled()
            // Quando la selezione cambia (anche programmaticamente, es. onSeeAll),
            // porta la pill corrispondente al centro.
            .onChange(of: selection) { _, newValue in
                withAnimation { proxy.scrollTo(newValue, anchor: .center) }
            }
        }
    }
}

struct WatchlistStateCard: View {
    let state: TitlePersonalState
    let container: AppContainer
    let session: SessionStore
    let shell: AppShellStore
    @Bindable var viewModel: WatchlistViewModel
    let onToggleWatchlist: () -> Void
    let onMarkSeen: () -> Void
    let onAddToList: () -> Void
    var platformNames: [String] = []
    var platformLogos: [String: URL] = [:]
    var showPlatformBadge: Bool = true
    /// Data di uscita, se il titolo non è ancora uscito. Arriva già risolta dal
    /// ViewModel: la card non interroga niente.
    var upcomingReleaseAt: Date?

    var body: some View {
        if let title = state.title {
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

                                    watchMetaRow(for: title)

                                    if let upcomingReleaseAt {
                                        WatchlistUpcomingBadge(date: upcomingReleaseAt)
                                    }

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
                            }

                            Text(state.statusSubtitle)
                                .font(.subheadline)
                                .foregroundStyle(TwoWatchTheme.textSecondary)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)

                            if let progressText = state.progressText {
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

                switch state.mediaType {
                case .movie:
                    HStack(spacing: 12) {
                        if state.isCompleted {
                            WatchlistIconActionButton(
                                systemName: "star",
                                accessibilityLabel: state.isRated ? String(localized: "Aggiorna il voto") : "Vota questo titolo",
                                tint: TwoWatchTheme.warning,
                                fillOpacity: 0.16,
                                action: {
                                    guard let title = state.title else { return }
                                    viewModel.activeRatingContext = RatingSheetContext(title: title)
                                }
                            )
                        } else {
                            WatchlistIconActionButton(
                                systemName: "checkmark",
                                accessibilityLabel: "Segna come visto",
                                tint: TwoWatchTheme.brandPrimary,
                                fillOpacity: 0.18,
                                action: onMarkSeen
                            )
                        }

                        WatchlistIconActionButton(
                            systemName: "bookmark.slash",
                            accessibilityLabel: state.generalWatchlist
                                ? "Rimuovi dalla watchlist"
                                : "Aggiungi alla watchlist",
                            tint: TwoWatchTheme.brandWarm,
                            fillOpacity: 0.14,
                            action: onToggleWatchlist
                        )

                        WatchlistIconActionButton(
                            systemName: "rectangle.stack.badge.plus",
                            accessibilityLabel: "Aggiungi a una lista",
                            tint: TwoWatchTheme.accent,
                            fillOpacity: 0.14,
                            action: onAddToList
                        )
                    }

                case .tv:
                    VStack(spacing: 12) {
                        WatchlistSeriesProgressDisclosure(
                            state: state,
                            session: session,
                            viewModel: viewModel,
                            container: container,
                            onToggleWatchlist: onToggleWatchlist,
                            onAddToList: onAddToList
                        )

                        if state.isCompleted {
                            WatchlistIconActionButton(
                                systemName: "star",
                                accessibilityLabel: state.isRated ? String(localized: "Aggiorna il voto") : String(localized: "Vota questa serie"),
                                tint: TwoWatchTheme.warning,
                                fillOpacity: 0.16,
                                action: {
                                    guard let title = state.title else { return }
                                    viewModel.activeRatingContext = RatingSheetContext(title: title)
                                }
                            )
                        } else {
                            WatchlistIconActionButton(
                                systemName: "checkmark",
                                accessibilityLabel: String(localized: "Segna la serie come completata"),
                                tint: TwoWatchTheme.brandPrimary,
                                fillOpacity: 0.18,
                                action: onMarkSeen
                            )
                        }
                    }
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
        }
    }

    @ViewBuilder
    private func watchMetaRow(for title: Title) -> some View {
        HStack(spacing: 8) {
            watchMetaPill(title.type.label, monospaced: false)

            if let year = title.year {
                watchMetaPill(String(year), monospaced: true)
            }

            if let secondaryMeta {
                Text(secondaryMeta)
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(TwoWatchTheme.textSecondary)
                    .lineLimit(1)
            }

            if let ownRatingText {
                HStack(spacing: 3) {
                    Image(systemName: "star.fill")
                        .font(.caption2.weight(.bold))
                    Text(ownRatingText)
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                }
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .foregroundStyle(TwoWatchTheme.warning)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(TwoWatchTheme.warning.opacity(0.14), in: Capsule())
                .accessibilityLabel("Il tuo voto \(ownRatingText)")
            }

            if showPlatformBadge, let platformText = watchlistPlatformBadgeText(platformNames) {
                WatchlistPlatformBadgeContent(names: platformNames, logos: platformLogos, textColor: TwoWatchTheme.textSecondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(TwoWatchTheme.panelStrong, in: Capsule())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Disponibile su \(platformText)")
            }
        }
    }

    @ViewBuilder
    private func watchMetaPill(_ text: String, monospaced: Bool = false) -> some View {
        Group {
            if monospaced {
                Text(text).monospacedDigit()
            } else {
                Text(text)
            }
        }
        .font(.caption2.weight(.black))
        // Una pill non si comprime e non va a capo.
        //
        // PERCHE' — senza questo, quando la riga e' affollata (tipo + anno +
        // stagioni + piattaforma) SwiftUI restringe le `Text` e spezza il testo
        // DENTRO la capsula: si leggeva "Se-rie" e "202 / 6". A cedere deve
        // essere il testo flessibile accanto, che ha gia' `lineLimit(1)` e
        // tronca con i puntini.
        .lineLimit(1)
        .fixedSize(horizontal: true, vertical: false)
        .foregroundStyle(TwoWatchTheme.textPrimary)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(TwoWatchTheme.panelStrong, in: Capsule())
    }

    private var secondaryMeta: String? {
        guard let title = state.title else { return nil }

        switch title.type {
        case .movie:
            if let durationMovie = title.metadata.durationMovie, durationMovie > 0 {
                let h = durationMovie / 60
                let m = durationMovie % 60
                if h > 0 {
                    return m > 0 ? "\(h)h \(m)m" : "\(h)h"
                }
                return "\(m) min"
            }
            return nil
        case .tv:
            if let seasonsCount = title.metadata.seasonsCount, seasonsCount > 0 {
                return String(localized: "\(seasonsCount) stagioni")
            }
            return nil
        }
    }

    private var ownRatingText: String? {
        guard let value = state.ratingValue, value > 0 else { return nil }
        return String(format: "%.1f", value)
    }
}


struct WatchlistIconActionButton: View {
    let systemName: String
    let accessibilityLabel: String
    let tint: Color
    let fillOpacity: Double
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.headline.weight(.black))
                .foregroundStyle(tint)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(tint.opacity(fillOpacity), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .stroke(tint.opacity(0.18), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}
