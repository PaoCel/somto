import Foundation

// Dove porta "guarda su …" per UN titolo, con quello che l'app ha gia' in mano.
//
// `StreamingDestinationResolver` ragiona su nomi e link e basta: e' condiviso
// col target widget, che il modello `Title` non lo ha. Questo strato sa da dove
// prendere nomi e link — i campi denormalizzati sul `Title` e, quando c'e', la
// risposta della callable (`TitleProviders`) — e decide se il bottone deve
// comparire.
//
// Lo usano la scheda titolo, le card del feed e la pagina del post: tre bottoni
// con lo stesso disegno devono finire nello stesso posto e comparire alle
// stesse condizioni. Prima questa logica viveva dentro la View della scheda, e
// portarla nel feed avrebbe voluto dire copiarla.
enum TitleWatchNowDestination {

    /// Le categorie che contano come "ce l'hai gia' dentro l'abbonamento".
    ///
    /// Noleggio e acquisto restano fuori: "Guarda su Rakuten TV" su un titolo da
    /// noleggiare a 4,99 e' la promessa sbagliata. E' lo stesso sottoinsieme che
    /// il server denormalizza in `watchProviderNames`
    /// (`extractStreamingPlatformNames` in functions/lib/watchProviders.js): due
    /// definizioni diverse di "dove si guarda" farebbero comparire il bottone
    /// solo mentre la callable e' in volo.
    static let subscriptionTypes: Set<String> = ["flatrate", "free", "ads", "custom"]

    /// La destinazione del bottone, o `nil` se il bottone non deve comparire.
    ///
    /// Non compare quando l'unico ripiego e' la pagina "dove guardare" di TMDB:
    /// quella non e' un'app, e un bottone che apre una pagina web di TMDB e' la
    /// promessa che fa dire "non funziona". Quel ripiego resta alla fila dei
    /// loghi della scheda titolo, che lo presenta per quello che e'.
    static func resolve(title: Title, providers: TitleProviders?) -> StreamingDestination? {
        guard let best = StreamingDestinationResolver.best(
            providerNames: providerNames(title: title, providers: providers),
            deepLinks: deepLinks(title: title, providers: providers),
            titleName: title.name,
            tmdbId: title.metadata.tmdbId,
            isSeries: title.type == .tv
        ) else { return nil }
        guard best.source != .tmdbWatchPage else { return nil }
        return best
    }

    /// I nomi delle piattaforme su cui il titolo si vede qui.
    ///
    /// Prima quelli della callable (aggiornati, per regione), altrimenti quelli
    /// denormalizzati sul titolo: sono la stessa fonte, e i secondi ci sono gia'
    /// mentre la callable e' in volo — cioe' nei primi secondi di ogni apertura
    /// della scheda, e SEMPRE nel feed, che la callable non la chiama.
    static func providerNames(title: Title, providers: TitleProviders?) -> [String] {
        if let providers, !providers.isEmpty {
            let names = (providers.providers + providers.customProviders)
                .filter { subscriptionTypes.contains($0.type.lowercased()) }
                .map(\.name)
            if !names.isEmpty { return names }
        }
        return title.watchProviderNames
    }

    /// I link diretti, dalle due stesse fonti. Si uniscono invece di scegliere:
    /// la callable puo' averne risolto uno nuovo che sul titolo non e' ancora
    /// stato denormalizzato, e viceversa dopo un refresh del catalogo.
    static func deepLinks(title: Title, providers: TitleProviders?) -> [String: URL] {
        var merged = title.watchDeepLinks
        for (name, url) in providers?.deepLinks ?? [:] {
            merged[name] = url
        }
        return merged
    }

    /// Il logo della piattaforma scelta, cercato prima col nome esatto e poi
    /// col nome collassato ("Apple TV Amazon Channel" → "Apple TV").
    static func logoURL(for providerName: String, title: Title, providers: TitleProviders?) -> URL? {
        if let exact = title.watchProviderLogos[providerName] { return exact }
        let base = StreamingProviderRanking.baseName(providerName).lowercased()
        if let collapsed = title.watchProviderLogos.first(where: {
            StreamingProviderRanking.baseName($0.key).lowercased() == base
        })?.value {
            return collapsed
        }
        let fromProviders = (providers?.providers ?? []) + (providers?.customProviders ?? [])
        return fromProviders.first {
            StreamingProviderRanking.baseName($0.name).lowercased() == base
        }?.logoURL
    }
}
