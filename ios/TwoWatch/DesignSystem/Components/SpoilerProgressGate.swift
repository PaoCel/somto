import SwiftUI

/// Gate anti-spoiler basato sul PROGRESSO del viewer.
///
/// Diverso da `SpoilerGate` (flag manuale dell'autore + titoli completati): qui
/// il contenuto porta con sé le coordinate (titolo / stagione / episodio) e il
/// gate le confronta con quanto il viewer ha davvero visto.
///
/// Regola identica al web (`public/js/components/spoilerProgress.js`) — se
/// cambia una, cambia l'altra: vedi `docs/context/SOCIAL_MODERATION.md`.
enum SpoilerProgressRule {
    /// Coordinate del contenuto (dal campo `spoilerScope` del post-eco).
    struct Scope: Hashable {
        let titleID: String
        /// `title` | `season` | `episode`
        let level: String
        let season: Int?
        let episode: Int?

        init(titleID: String, level: String, season: Int?, episode: Int?) {
            self.titleID = titleID
            self.level = ["title", "season", "episode"].contains(level) ? level : "title"
            self.season = (season ?? 0) > 0 ? season : nil
            self.episode = (episode ?? 0) > 0 ? episode : nil
        }

        /// Etichetta breve mostrata accanto all'autore ("S3·E7").
        var shortLabel: String? {
            if level == "episode", let season, let episode {
                return "S\(season)·E\(episode)"
            }
            if level == "season", let season {
                return String(localized: "Stagione \(season)")
            }
            return nil
        }
    }

    /// Progresso del viewer su quel titolo (nil = titolo non in libreria).
    struct Entry: Hashable {
        let mediaType: MediaType
        let movieStatus: MoviePersonalStatus?
        let seriesStatus: SeriesPersonalStatus?
        let lastSeason: Int
        let lastEpisode: Int

        init(state: TitlePersonalState) {
            mediaType = state.mediaType
            movieStatus = state.movieStatus
            seriesStatus = state.seriesStatus
            lastSeason = state.seriesProgress?.lastWatchedSeasonNumber ?? 0
            lastEpisode = state.seriesProgress?.lastWatchedEpisodeNumber ?? 0
        }
    }

    /// Il viewer può leggere il contenuto in chiaro?
    static func isUnlocked(scope: Scope?, entry: Entry?) -> Bool {
        guard let scope else { return true }          // niente coordinate, niente da nascondere
        guard let entry else { return false }         // titolo non in libreria = bloccato

        switch entry.mediaType {
        case .movie:
            return entry.movieStatus == .seenUnrated || entry.movieStatus == .rated
        case .tv:
            if entry.seriesStatus == .completedUnrated || entry.seriesStatus == .rated {
                return true
            }
            if scope.level == "episode", let season = scope.season, let episode = scope.episode {
                if entry.lastSeason == 0 { return false }
                if entry.lastSeason > season { return true }
                if entry.lastSeason < season { return false }
                return entry.lastEpisode >= episode
            }
            if scope.level == "season", let season = scope.season {
                // Serve aver superato la stagione: dentro la stagione stessa un
                // commento "di stagione" può bruciare il finale.
                return entry.lastSeason > season
            }
            // Livello titolo: basta aver iniziato la serie.
            return entry.seriesStatus == .inProgress
        }
    }
}

/// Wrapper di rendering: sfoca il contenuto finché il viewer non è arrivato a
/// quel punto, con overlay e sblocco per-contenuto ("Tocca per mostrare").
///
/// Nessun bottone "Ho visto X": marcare un titolo completato per leggere un
/// commento falsificherebbe la libreria.
struct SpoilerProgressGate<Content: View>: View {
    let scope: SpoilerProgressRule.Scope?
    let entry: SpoilerProgressRule.Entry?
    let titleName: String?
    /// Il proprio commento non si sfoca mai: lo spoiler è tuo.
    let isOwnContent: Bool
    @ViewBuilder var content: () -> Content

    @State private var revealed = false

    private var isHidden: Bool {
        if isOwnContent || revealed { return false }
        return !SpoilerProgressRule.isUnlocked(scope: scope, entry: entry)
    }

    var body: some View {
        ZStack {
            content()
                .blur(radius: isHidden ? 18 : 0)
                .allowsHitTesting(!isHidden)
                .accessibilityHidden(isHidden)

            if isHidden {
                overlay.transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isHidden)
    }

    private var overlay: some View {
        VStack(spacing: 8) {
            Image(systemName: "eye.slash.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(TwoWatchTheme.brandPrimary)

            Text("Contiene spoiler")
                .font(.headline.weight(.bold))
                .foregroundStyle(TwoWatchTheme.textPrimary)

            Text(subtitle)
                .font(.caption)
                .multilineTextAlignment(.center)
                .foregroundStyle(TwoWatchTheme.textSecondary)
                .padding(.horizontal, 12)

            Button("Tocca per mostrare") {
                revealed = true
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(TwoWatchTheme.brandPrimary, in: Capsule())
        }
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var subtitle: String {
        // Con coordinate precise si dice a che punto ci si riferisce; senza,
        // vale il caso generale (film mai visto, serie mai iniziata, titolo
        // fuori libreria).
        let base: String
        if let label = scope?.shortLabel {
            base = String(localized: "Commento su \(label): non sei ancora arrivato qui.")
        } else {
            base = String(localized: "Non hai ancora visto questo titolo.")
        }
        guard let titleName, !titleName.isEmpty else { return base }
        return "\(titleName) · \(base)"
    }
}
