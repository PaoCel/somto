import Foundation

// Da `WatchlistDashboard` alle righe del widget.
//
// Vive nel target dell'app e non in `WatchlistWidgetSnapshot.swift` (che invece
// e' compilato anche dentro l'estensione) perche' tocca i modelli di dominio:
// portarseli nel widget vorrebbe dire compilare li' meta' del layer dati per
// una struct di dieci campi.

enum WatchlistWidgetSnapshotBuilder {
    /// Quante serie in corso finiscono nel file.
    ///
    /// Non e' solo quel che si disegna (il widget piu' grande ne mostra cinque):
    /// questa lista e' anche l'ELENCO CHE COMPARE quando si sceglie la serie del
    /// widget "Segna episodio". Feedback dal device il 2026-08-14: "mi faceva
    /// vedere cinque serie quando in watchlist ne ho molte di piu'". Erano
    /// davvero le sue serie in corso, ma il tetto stretto le avrebbe tagliate
    /// comunque.
    static let inProgressLimit = 20

    /// Quanti titoli della coda. Nel widget-elenco sono il contorno, ma anche
    /// qui il selettore vuole scelta: una serie che non hai ancora iniziato e'
    /// un bersaglio legittimo per il bottone, che le segnera' il primo episodio.
    static let upNextLimit = 20

    /// Il riassunto a partire da cio' che la HOME ha gia' in mano.
    ///
    /// PERCHE' ESISTE — il riassunto lo scriveva solo la Watchlist, quindi il
    /// widget restava sullo stato "apri Somto" finche' non si visitava quella
    /// tab. Sul device e' successo esattamente questo (2026-08-14): app aperta,
    /// widget fermo; solo dopo un passaggio dalla Watchlist e' comparso.
    /// La Home ha gia' `continueWatching`, cioe' le serie in corso: scriverlo da
    /// li' non costa una lettura in piu' e copre il caso "ho appena aggiornato".
    ///
    /// Le voci "da guardare" non le ha: si tengono quelle gia' sul disco invece
    /// di cancellarle, cosi' un riassunto scritto dalla Home non impoverisce
    /// quello scritto dalla Watchlist.
    static func snapshot(
        fromHome continueWatching: [TitlePersonalState],
        existing: WatchlistWidgetSnapshot? = WatchlistWidgetSnapshotStore.read(),
        updatedAt: Date = Date()
    ) -> WatchlistWidgetSnapshot {
        var seen: Set<String> = []
        let inProgress = continueWatching
            .filter { $0.isInProgressSeries }
            .compactMap { row(from: $0, kind: .inProgress) }
            .filter { seen.insert($0.id).inserted }
            .prefix(inProgressLimit)

        let keptUpNext = (existing?.rows ?? [])
            .filter { $0.kind == .upNext && seen.insert($0.id).inserted }
            .prefix(upNextLimit)

        return WatchlistWidgetSnapshot(rows: Array(inProgress) + Array(keptUpNext), updatedAt: updatedAt)
    }

    static func snapshot(from dashboard: WatchlistDashboard, updatedAt: Date = Date()) -> WatchlistWidgetSnapshot {
        var seen: Set<String> = []

        let inProgress = dashboard.inProgressSeries
            .compactMap { row(from: $0, kind: .inProgress) }
            .filter { seen.insert($0.id).inserted }
            .prefix(inProgressLimit)

        // La coda esclude cio' che e' gia' in corso: la stessa serie due volte,
        // una come "sei a S3·E7" e una come "da guardare", sarebbe una riga
        // sprecata e una contraddizione.
        let upNext = dashboard.generalWatchlist
            .filter { !$0.isInProgressSeries }
            .compactMap { row(from: $0, kind: .upNext) }
            .filter { seen.insert($0.id).inserted }
            .prefix(upNextLimit)

        return WatchlistWidgetSnapshot(rows: Array(inProgress) + Array(upNext), updatedAt: updatedAt)
    }

    /// Una riga, oppure niente: senza titolo idratato non ci sarebbe il nome, e
    /// una riga senza nome non e' una riga.
    private static func row(
        from state: TitlePersonalState,
        kind: WatchlistWidgetSnapshot.Row.Kind
    ) -> WatchlistWidgetSnapshot.Row? {
        guard let title = state.title else { return nil }
        let name = title.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }

        let progress = kind == .inProgress ? state.seriesProgress : nil
        // La piattaforma principale: la prima con il logo, che e' gia' ordinata
        // come TMDB la serve per l'Italia (abbonamento, poi gratis, poi con
        // pubblicita'). I "canali dentro un altro servizio" si scartano come nel
        // feed delle uscite: stesso marchio, etichetta piu' lunga.
        // L'ordine di TMDB non basta: mette Prime Video davanti anche quando il
        // titolo e' di un altro servizio che Prime si limita a rivendere (Ted
        // Lasso, 2026-08-15). `StreamingProviderRanking` mette in testa la casa
        // vera del titolo.
        let providerName = StreamingProviderRanking.primary(title.watchProviderNames)

        return WatchlistWidgetSnapshot.Row(
            id: state.titleId,
            name: name,
            isSeries: state.mediaType == .tv,
            kind: kind,
            season: progress?.lastWatchedSeasonNumber,
            episode: progress?.lastWatchedEpisodeNumber,
            episodesWatched: progress.map { max(0, $0.episodesWatchedCount) },
            episodesTotal: progress?.totalEpisodeCount,
            percentComplete: progress?.percentComplete,
            episodeMinutes: title.metadata.durationEpisode,
            providerName: providerName,
            // Il logo e' indicizzato col nome che TMDB usa, che puo' essere
            // quello lungo ("Apple TV Amazon Channel"): si prova il nome scelto
            // e poi qualunque voce che collassi su di lui.
            providerLogoUrl: widgetLogoURL(providerName.flatMap { name in
                title.watchProviderLogos[name]
                    ?? title.watchProviderLogos.first { StreamingProviderRanking.baseName($0.key) == name }?.value
            }),
            // Il link diretto al titolo dentro la piattaforma non ce l'ha
            // nessuna delle nostre fonti: resta `nil` e il widget ripiega sulla
            // ricerca (`WidgetWatchLink`). Vive qui perche' e' il posto giusto
            // il giorno che una fonte arriva.
            watchUrl: nil,
            tmdbId: title.metadata.tmdbId,
            posterUrl: widgetPosterURL(title.posterPath),
            path: "/share/title/\(state.titleId)"
        )
    }

    /// Il logo della piattaforma, ridotto: nel widget e' alto quanto una riga
    /// di testo.
    static func widgetLogoURL(_ url: URL?) -> URL? {
        tmdbImageURL(url, width: "w92")
    }

    /// La locandina alla misura che serve a un widget.
    ///
    /// Nell'app la poster e' una `w500`: dentro una riga alta 45pt sono ~5 volte
    /// i pixel che si vedranno, e quei byte viaggiano dentro la timeline del
    /// widget. Stessa riscrittura che fa il server per le prossime uscite
    /// (`normalizeTmdbImageUrl` in functions/modules/upcomingReleasesFeed.js).
    static func widgetPosterURL(_ url: URL?) -> URL? {
        tmdbImageURL(url, width: "w185")
    }

    private static func tmdbImageURL(_ url: URL?, width: String) -> URL? {
        guard let url, url.host()?.lowercased() == "image.tmdb.org" else { return url }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.path = url.path().replacingOccurrences(
            of: #"^/t/p/[^/]+/"#,
            with: "/t/p/\(width)/",
            options: .regularExpression
        )
        return components?.url ?? url
    }
}
