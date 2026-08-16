import Foundation

// L'unico posto che sa dove porta "guarda su …".
//
// PERCHE' UNO SOLO — la stessa domanda la fanno la scheda titolo, il widget
// grande e domani chissa' cos'altro. Se ognuno se la risolve, il primo che
// cambia (un dominio, un ripiego, un provider nuovo) lascia gli altri indietro,
// e nascono le catene di `if netflix { } if disney { }` sparse per l'app.
//
// LA CATENA, in ordine di precisione:
//
//  1. **link diretto** — arriva dal server in `titles.watchDeepLinks` /
//     `titleProviders.deepLinks`, risolto da Wikidata (id Netflix, Disney+,
//     Apple TV, Max). Apre la piattaforma sul titolo esatto, e sull'iPhone
//     l'universal link apre l'app se installata.
//  2. **ricerca nell'app della piattaforma** — per i servizi che sappiamo
//     aprire ma di cui non abbiamo l'id. Resta dentro le app, un tap in piu'.
//  3. **pagina "dove guardare" di TMDB** — l'ultimo ripiego, quello che la
//     scheda titolo usa da sempre. Passa dal browser ma i link dentro sono
//     quelli veri.
//
// COSA QUESTO FILE NON DECIDE — su quali piattaforme un titolo si veda. Quello
// lo dicono i watch provider TMDB, che sono per regione; qui si decide solo
// DOVE porta il bottone di una piattaforma che TMDB ha gia' dichiarato. Un id
// Netflix esiste anche per titoli che in Italia stanno altrove: usarlo come
// prova di disponibilita' sarebbe un bottone che mente.

enum StreamingLinkSource: String, Sendable, Hashable {
    /// Deep link risolto dal server (oggi: Wikidata).
    case direct
    /// Ricerca dentro l'app della piattaforma.
    case providerSearch
    /// Pagina "dove guardare" di TMDB.
    case tmdbWatchPage
}

struct StreamingDestination: Sendable, Hashable {
    let providerName: String
    let url: URL
    let source: StreamingLinkSource

    /// Se il salto e' su una scheda precisa o su una ricerca. Serve al copy:
    /// promettere "Guarda su Netflix" per una ricerca sarebbe esagerato.
    var isExact: Bool { source == .direct }
}

/// Quale piattaforma conta davvero, quando TMDB ne elenca quattro.
///
/// IL PROBLEMA, visto sul device il 2026-08-15 — Ted Lasso e' su Apple TV+, ma
/// TMDB per l'Italia risponde in quest'ordine: `Amazon Prime Video`, `Apple TV`,
/// `Apple TV Amazon Channel`, `Amazon Prime Video with Ads`. Prime e' primo
/// perche' RIVENDE Apple TV+ come canale, non perche' il titolo sia suo. Chi
/// prendeva il primo nome si ritrovava "Guarda su Prime Video" su una serie
/// Apple.
///
/// LA REGOLA — Prime e' un negozio oltre che un servizio. Se nella lista c'e'
/// anche un altro servizio in abbonamento, quello e' la casa del titolo e Prime
/// scende in fondo. Se Prime e' l'unico, allora e' davvero Prime.
enum StreamingProviderRanking {

    /// I nomi con cui TMDB scrive Amazon: nessuno di questi e' la casa di un
    /// titolo se c'e' dell'altro.
    private static let resellers: Set<String> = [
        "amazon prime video",
        "amazon prime video with ads",
        "amazon video",
    ]

    /// "Apple TV Amazon Channel" e "Apple TV" sono lo stesso servizio: il primo
    /// e' solo il modo in cui lo si paga. Si collassano, cosi' non compaiono due
    /// loghi per la stessa cosa e il link va all'app giusta.
    static func baseName(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        for suffix in [" amazon channel", " amazon channels", " apple tv channel", " with ads"] where lower.hasSuffix(suffix) {
            return String(trimmed.dropLast(suffix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmed
    }

    /// L'elenco ripulito: nomi collassati, doppioni via, e i rivenditori in
    /// fondo quando c'e' un servizio vero.
    static func ranked(_ names: [String]) -> [String] {
        var seen: Set<String> = []
        let collapsed = names
            .map(baseName)
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }

        let veri = collapsed.filter { !resellers.contains($0.lowercased()) }
        let rivenditori = collapsed.filter { resellers.contains($0.lowercased()) }
        return veri.isEmpty ? rivenditori : veri + rivenditori
    }

    /// La piattaforma da mostrare quando ce n'e' posto per una sola.
    static func primary(_ names: [String]) -> String? {
        ranked(names).first
    }
}

enum StreamingDestinationResolver {

    /// Le piattaforme che sappiamo aprire per nome, quando l'id manca.
    ///
    /// La chiave e' il nome come lo scrive TMDB, minuscolo. I "canali dentro un
    /// altro servizio" ("HBO Max Amazon Channel") non hanno una riga loro: li
    /// gestisce `searchTemplate(for:)`, che li manda su Prime Video — che e'
    /// l'app dove si guardano davvero.
    ///
    /// PRIME VIDEO STA QUI E NON FRA I LINK DIRETTI: su Wikidata i suoi id sono
    /// ASIN del catalogo statunitense — `amazon.com` risponde, ma lo stesso id
    /// su `primevideo.com` e `amazon.it` da' 404 (verificato il 2026-08-15).
    /// Per un utente italiano la ricerca e' meglio di un link rotto.
    private static let searchTemplates: [String: String] = [
        "netflix": "https://www.netflix.com/search?q=",
        "disney plus": "https://www.disneyplus.com/search?q=",
        "amazon prime video": "https://www.primevideo.com/search/?phrase=",
        "apple tv": "https://tv.apple.com/search?term=",
        "apple tv+": "https://tv.apple.com/search?term=",
        "paramount plus": "https://www.paramountplus.com/search/?query=",
        "now tv": "https://www.nowtv.it/cerca?q=",
        "sky go": "https://www.sky.it/cerca?q=",
        // TMDB scrive "Rai Play" con lo spazio: la chiave senza spazio non
        // matchava niente, e quei titoli finivano sul ripiego (5 su 493 nel
        // catalogo del 2026-08-15). Si tengono entrambe le forme.
        "rai play": "https://www.raiplay.it/ricerca.html?q=",
        "raiplay": "https://www.raiplay.it/ricerca.html?q=",
        "mediaset infinity": "https://mediasetinfinity.mediaset.it/ricerca?q=",
        "infinity+": "https://mediasetinfinity.mediaset.it/ricerca?q=",
        "crunchyroll": "https://www.crunchyroll.com/it/search?q=",
        "rakuten tv": "https://rakuten.tv/it/search?q=",
        "mubi": "https://mubi.com/it/it/search/films?query=",
        "plex": "https://watch.plex.tv/search?q=",
        "timvision": "https://www.timvision.it/ricerca?q=",
        "discovery+": "https://www.discoveryplus.com/it/search?q=",
    ]

    /// Dove mandare chi tocca il bottone di UNA piattaforma.
    ///
    /// - Parameters:
    ///   - providerName: il nome come lo da' TMDB, cioe' quello gia' mostrato.
    ///   - deepLinks: i link diretti che il server ha risolto per questo titolo.
    ///   - titleName: serve alla ricerca.
    ///   - tmdbId/isSeries: servono al ripiego finale.
    static func destination(
        providerName: String,
        deepLinks: [String: URL],
        titleName: String,
        tmdbId: Int?,
        isSeries: Bool
    ) -> StreamingDestination? {
        let trimmed = providerName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let base = StreamingProviderRanking.baseName(trimmed)
        if let direct = deepLinks[trimmed]
            ?? deepLinks[base]
            ?? deepLinks[canonicalName(base) ?? base] {
            return StreamingDestination(providerName: trimmed, url: direct, source: .direct)
        }

        if let template = searchTemplate(for: trimmed),
           let query = titleName.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
           let url = URL(string: template + query) {
            return StreamingDestination(providerName: trimmed, url: url, source: .providerSearch)
        }

        if let page = tmdbWatchPage(tmdbId: tmdbId, isSeries: isSeries) {
            return StreamingDestination(providerName: trimmed, url: page, source: .tmdbWatchPage)
        }

        return nil
    }

    /// La destinazione migliore fra le piattaforme disponibili.
    ///
    /// Le sceglie nell'ordine in cui TMDB le serve (abbonamento prima), ma un
    /// link diretto batte l'ordine: meglio la seconda piattaforma sulla scheda
    /// esatta che la prima su una ricerca.
    static func best(
        providerNames: [String],
        deepLinks: [String: URL],
        titleName: String,
        tmdbId: Int?,
        isSeries: Bool
    ) -> StreamingDestination? {
        let candidates = StreamingProviderRanking.ranked(providerNames).compactMap {
            destination(
                providerName: $0,
                deepLinks: deepLinks,
                titleName: titleName,
                tmdbId: tmdbId,
                isSeries: isSeries
            )
        }
        return candidates.first(where: { $0.source == .direct })
            ?? candidates.first(where: { $0.source == .providerSearch })
            ?? candidates.first
    }

    /// Questo indirizzo porta FUORI da Somto, su una piattaforma di streaming?
    ///
    /// PERCHE' SERVE — un tap su un widget non apre mai l'app di destinazione:
    /// iOS consegna l'URL all'app CONTENITRICE, cioe' Somto. Senza questo
    /// controllo, `destinationForURL` non riconosceva `tv.apple.com` e ripiegava
    /// sul browser interno: si toccava play e si finiva dentro Somto a guardare
    /// una pagina web di Apple TV (constatato sul device il 2026-08-16).
    /// Riconoscendolo, l'app lo ripassa al sistema, che apre l'app giusta se
    /// c'e' — che e' quello che il tap prometteva.
    static func isExternalWatchDestination(_ url: URL) -> Bool {
        guard let host = url.host()?.lowercased() else { return false }
        return watchHosts.contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    /// I domini che consideriamo "posti dove si guarda". Sono quelli che questo
    /// file stesso produce: le ricerche qui sopra, i link diretti risolti dal
    /// server e la pagina "dove guardare" di TMDB.
    private static let watchHosts: Set<String> = [
        "netflix.com",
        "disneyplus.com",
        "primevideo.com",
        "amazon.com",
        "amazon.it",
        "tv.apple.com",
        "max.com",
        "hbomax.com",
        "paramountplus.com",
        "nowtv.it",
        "sky.it",
        "raiplay.it",
        "mediasetinfinity.mediaset.it",
        "crunchyroll.com",
        "rakuten.tv",
        "mubi.com",
        "plex.tv",
        "timvision.it",
        "discoveryplus.com",
        "themoviedb.org",
    ]

    /// La pagina "dove guardare" di TMDB, la stessa che la scheda titolo apre da
    /// sempre. Si costruisce dall'id TMDB invece di leggere `titleProviders.link`:
    /// e' esattamente lo stesso URL (verificato sul catalogo) e cosi' funziona
    /// anche dove quel documento non e' stato caricato, widget compreso.
    static func tmdbWatchPage(tmdbId: Int?, isSeries: Bool, locale: String = "IT") -> URL? {
        guard let tmdbId, tmdbId > 0 else { return nil }
        return URL(string: "https://www.themoviedb.org/\(isSeries ? "tv" : "movie")/\(tmdbId)/watch?locale=\(locale)")
    }

    /// Il modello di ricerca per una piattaforma, con una regola in piu' per i
    /// canali venduti dentro Prime Video.
    ///
    /// "HBO Max Amazon Channel", "MGM Plus Amazon Channel", "MIDNIGHT FACTORY
    /// Amazon Channel" — sono 20+ nomi diversi nel catalogo, ma si guardano
    /// tutti nella stessa app: Prime Video. Mandarli li' e' giusto ed e' anche
    /// il gruppo piu' numeroso fra quelli che prima finivano sul ripiego.
    private static func searchTemplate(for providerName: String) -> String? {
        if let template = searchTemplates[providerName.lowercased()] { return template }
        // "Apple TV Amazon Channel" e' Apple TV pagato dentro Amazon: la scheda
        // del titolo sta su Apple, ed e' li' che ha senso mandare. Prima
        // finivano tutti su una ricerca in Prime Video — che e' come TMDB fa
        // sembrare Apple una serie Amazon.
        let base = StreamingProviderRanking.baseName(providerName).lowercased()
        if let template = searchTemplates[base] { return template }
        // Restano i canali di marchi che non sappiamo aprire (MGM+, Midnight
        // Factory): quelli si guardano davvero dentro Prime Video.
        if providerName.lowercased().hasSuffix("amazon channel") { return searchTemplates["amazon prime video"] }
        return nil
    }

    /// Gli alias con cui TMDB scrive la stessa piattaforma, allineati a quelli
    /// del server (`functions/lib/wikidataStreamingLinks.js`).
    private static func canonicalName(_ name: String) -> String? {
        switch name.lowercased() {
        case "netflix", "netflix basic with ads", "netflix standard with ads": return "Netflix"
        case "disney plus", "disney+": return "Disney Plus"
        case "apple tv", "apple tv+", "apple tv plus": return "Apple TV"
        case "hbo max", "max": return "HBO Max"
        case "paramount plus", "paramount+": return "Paramount Plus"
        default: return nil
        }
    }
}
