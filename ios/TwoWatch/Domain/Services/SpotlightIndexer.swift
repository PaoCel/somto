import CoreSpotlight
import CryptoKit
import Foundation
import UniformTypeIdentifiers

// Indicizzazione dei titoli dell'utente nella ricerca di sistema (Spotlight).
//
// PERCHE' CoreSpotlight E NON `IndexedEntity` — `IndexedEntity` (App Intents)
// e' iOS 18, il deployment target e' 17.0: usarlo taglierebbe fuori la fetta di
// utenti ancora su iOS 17. `CSSearchableIndex` c'e' da sempre e copre il caso
// utile: cerchi "Dune" da Spotlight, il risultato Somto apre la scheda titolo.
//
// PERCHE' NON RIUSA GLI App Intent — `AddToWatchlistIntent` e' volutamente
// nascosto (`isDiscoverable = false`) perche' rotto. Questo lavoro e'
// indipendente: non lo riesuma e non ne dipende.

// MARK: - Cosa finisce nell'indice

/// Il minimo che serve per una riga di Spotlight, in forma `Sendable`.
///
/// Esiste come tipo a se' invece di passare `Title` per due motivi: e' la
/// superficie **pura** (costruzione del sottotitolo, keyword, taglio della
/// trama) che i test possono verificare senza toccare CoreSpotlight, ed e'
/// esplicitamente `Sendable`, cosi' la scrittura vera puo' uscire dal main
/// actor senza appoggiarsi alla conformance implicita di `Title`.
struct SpotlightTitleSnapshot: Sendable, Hashable, Identifiable {
    /// Doc id Firestore del titolo: e' anche lo `uniqueIdentifier` dell'item e
    /// quello che torna indietro al tap (`SpotlightIndexer.titleID(from:)`).
    let id: String
    let name: String
    /// Riga sotto il nome: "Serie · 2016 · Fantascienza, Dramma".
    let subtitle: String
    /// Trama, tagliata: Spotlight ne mostra due righe, il resto e' peso morto.
    let overview: String?
    let keywords: [String]
    /// Poster remoto, alla misura con cui l'ha il resto dell'app. Chi indicizza
    /// la riduce e la scarica solo entro il budget di
    /// `CoreSpotlightIndexWriter.thumbnailDownloadLimit`.
    let posterURL: URL?
}

extension SpotlightTitleSnapshot {

    /// Generi che entrano nel sottotitolo. Tre bastano a distinguere due titoli
    /// omonimi; oltre, Spotlight tronca comunque la riga.
    static let subtitleGenreLimit = 3

    /// Tetto alle keyword: sono un aiuto al matching, non un dump del documento.
    static let keywordLimit = 8

    /// Caratteri di trama conservati.
    static let overviewLimit = 220

    /// - Parameter genreLookup: la tabella id → nome che la Watchlist ha gia'
    ///   caricato (`GenreDisplay.lookup(from:)`). Senza, `Title.genres` e' un
    ///   elenco di id TMDB e Spotlight mostrerebbe "Film · 2026 · tmdb_27".
    init(_ title: Title, genreLookup: [String: String] = [:]) {
        var parts: [String] = [title.type.label]
        // `String(year)` e non `format:`: un anno non va raggruppato, un
        // formatter numerico scriverebbe "2.016" (docs/context/IOS_CODE_STYLE.md §6.5).
        if let year = title.year {
            parts.append(String(year))
        }

        // `GenreDisplay` risolve prima dalla tabella caricata, poi dalla
        // tabella locale di riserva, e **scarta** cio' che non sa tradurre: un
        // id rimasto tale sarebbe rumore in una riga che l'utente legge in un
        // decimo di secondo. Se non resta niente, il sottotitolo si ferma a
        // "Film · 2026" invece di finire con un separatore a vuoto.
        let genres = GenreDisplay.labels(from: title.genres, lookup: genreLookup)
        let subtitleGenres = genres.prefix(Self.subtitleGenreLimit).joined(separator: ", ")
        if !subtitleGenres.isEmpty {
            parts.append(subtitleGenres)
        }

        // Il titolo originale e gli alias sono il motivo per cui le keyword
        // servono: chi cerca "Money Heist" non trova "La Casa di Carta" con il
        // solo `title`.
        var candidates: [String] = [title.name]
        if let original = title.originalName {
            candidates.append(original)
        }
        candidates.append(contentsOf: title.aliases)
        // I generi tradotti, non gli id: cercare "tmdb_27" non lo fa nessuno.
        candidates.append(contentsOf: genres)

        var seen: Set<String> = []
        let keywords = candidates
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
            .prefix(Self.keywordLimit)

        self.init(
            id: title.id,
            name: title.name,
            subtitle: parts.joined(separator: " · "),
            overview: Self.shortOverview(title.description),
            keywords: Array(keywords),
            posterURL: title.posterPath
        )
    }

    static func shortOverview(_ text: String?) -> String? {
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        guard trimmed.count > overviewLimit else { return trimmed }
        return String(trimmed.prefix(overviewLimit)) + "…"
    }
}

// MARK: - Cosa si indicizza, e quanto

extension SpotlightTitleSnapshot {

    /// Tetto ai titoli indicizzati.
    ///
    /// PERCHE' UN TETTO — ogni item costa una scrittura nell'indice di sistema
    /// piu' (dove c'e') una miniatura letta da disco. Un utente arrivato da un
    /// import TV Time ha migliaia di titoli visti: indicizzarli tutti sarebbe
    /// batteria e I/O spesi per righe che nessuno cerchera' mai. Duecento
    /// coprono la coda attiva di chiunque, che e' esattamente cio' che uno
    /// cerca dalla ricerca di sistema.
    static let indexLimit = 200

    /// Estrae i titoli da indicizzare dal dashboard **gia' caricato** dalla
    /// Watchlist: nessuna query in piu' su Firestore.
    ///
    /// L'ordine e' priorita': prima cio' che l'utente sta guardando adesso,
    /// poi cio' che vuole guardare, per ultimo il rewatch. Se il tetto taglia,
    /// taglia dalla coda meno urgente.
    ///
    /// La libreria completa (`fetchLibrary`) di proposito **non** entra qui:
    /// e' non limitata e la si carica solo aprendo il Profilo, quindi
    /// mescolarla renderebbe il contenuto dell'indice dipendente da quale
    /// schermata l'utente ha aperto per ultima.
    static func snapshots(
        from dashboard: WatchlistDashboard,
        limit: Int = indexLimit,
        genreLookup: [String: String] = [:]
    ) -> [SpotlightTitleSnapshot] {
        guard limit > 0 else { return [] }

        let ordered = dashboard.inProgressSeries
            + dashboard.toResume
            + dashboard.generalWatchlist
            + dashboard.toRate
            + dashboard.rewatch

        var seen: Set<String> = []
        var result: [SpotlightTitleSnapshot] = []
        result.reserveCapacity(min(limit, ordered.count))

        for state in ordered {
            guard result.count < limit else { break }
            // Uno stato senza `title` idratato non ha niente da mostrare: una
            // riga Spotlight con il solo doc id sarebbe peggio dell'assenza.
            guard let title = state.title, !title.id.isEmpty else { continue }
            guard seen.insert(title.id).inserted else { continue }
            result.append(SpotlightTitleSnapshot(title, genreLookup: genreLookup))
        }

        return result
    }
}

// MARK: - Scrittura

/// La scrittura sull'indice, dietro un protocollo perche' i test possano
/// verificare *quando* si scrive e *quando* si cancella senza sporcare
/// l'indice di sistema della macchina che li esegue.
protocol SpotlightIndexWriting: Sendable {
    /// Sostituisce l'intero contenuto del dominio.
    func replaceAll(with snapshots: [SpotlightTitleSnapshot], domainIdentifier: String) async throws
    /// Svuota il dominio.
    func removeAll(domainIdentifier: String) async throws
}

/// Implementazione CoreSpotlight. `nonisolated` di proposito: la costruzione
/// degli item legge le poster da `URLCache.shared` (I/O su disco) e, per le
/// prime, le scarica; duecento letture piu' una manciata di richieste sul main
/// actor si vedrebbero come uno scatto durante il caricamento della Watchlist.
struct CoreSpotlightIndexWriter: SpotlightIndexWriting {

    /// Una poster piu' grande di cosi' non entra come miniatura: Spotlight la
    /// ridimensiona comunque, e duecento immagini pesanti gonfierebbero
    /// l'indice per un guadagno visivo nullo.
    static let maxThumbnailBytes = 300 * 1024

    /// Larghezza TMDB richiesta per le miniature. Spotlight disegna un quadrato
    /// da poche decine di punti: `w154` e' gia' abbondante, e sono ~10 KB
    /// contro i ~60 di una `w500`.
    static let thumbnailWidth = 154

    /// Quante locandine si possono **scaricare** in un giro di indicizzazione.
    ///
    /// PERCHE' UN BUDGET, E PERCHE' COSI' STRETTO — l'indicizzazione riparte a
    /// ogni caricamento della Watchlist, e i titoli indicizzati sono fino a
    /// `SpotlightTitleSnapshot.indexLimit` (200). Scaricare duecento locandine
    /// ogni volta sarebbe traffico e batteria spesi per miniature che quasi
    /// nessuno vedra': chi cerca dalla ricerca di sistema cerca quello che sta
    /// guardando adesso, che e' esattamente cio' che l'ordinamento degli
    /// snapshot mette in testa. Le prime trenta coprono quel caso; per tutto il
    /// resto vale la cache, che e' gratis e con l'uso si riempie da sola.
    static let thumbnailDownloadLimit = 30

    /// Tetto per singola richiesta e tetto complessivo. Superato il secondo si
    /// smette di chiedere e si indicizza con le miniature che ci sono: un
    /// indice senza copertine e' accettabile, tenere occupata la rete per un
    /// lavoro di sfondo no.
    static let thumbnailRequestTimeout: TimeInterval = 5
    static let thumbnailTotalBudget: TimeInterval = 12

    /// Richieste in volo insieme. Quattro tengono occupata la connessione senza
    /// competere con il caricamento della schermata che l'utente sta guardando.
    static let thumbnailConcurrency = 4

    /// Scadenza degli item. Non `distantFuture`: un indice che decade da solo
    /// e' la rete di sicurezza per l'utente che smette di aprire l'app. Non il
    /// mese di default: chi apre la Watchlist ogni tanto non deve vedere i
    /// propri titoli sparire dalla ricerca.
    static let expiration: TimeInterval = 180 * 24 * 60 * 60

    func replaceAll(with snapshots: [SpotlightTitleSnapshot], domainIdentifier: String) async throws {
        guard CSSearchableIndex.isIndexingAvailable() else { return }
        let index = CSSearchableIndex.default()

        // Le miniature si raccolgono PRIMA della cancellazione: fra il delete e
        // la riscrittura l'indice e' vuoto, e quella finestra deve restare di
        // millisecondi, non durare quanto il budget di rete.
        let thumbnails = snapshots.isEmpty ? [:] : await Self.thumbnails(for: snapshots)

        // CoreSpotlight non ha una sostituzione atomica: `indexSearchableItems`
        // e' un upsert per `uniqueIdentifier`, quindi da solo lascerebbe dentro
        // i titoli tolti dalla watchlist. Si cancella il dominio e si riscrive.
        try await index.deleteSearchableItems(withDomainIdentifiers: [domainIdentifier])

        guard !snapshots.isEmpty else { return }
        let items = snapshots.map {
            Self.makeItem($0, thumbnailData: thumbnails[$0.id], domainIdentifier: domainIdentifier)
        }
        try await index.indexSearchableItems(items)
    }

    func removeAll(domainIdentifier: String) async throws {
        guard CSSearchableIndex.isIndexingAvailable() else { return }
        try await CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domainIdentifier])
    }

    private static func makeItem(
        _ snapshot: SpotlightTitleSnapshot,
        thumbnailData: Data?,
        domainIdentifier: String
    ) -> CSSearchableItem {
        // `.content` e non `.movie`: quello che indicizziamo e' la *scheda* di
        // un titolo, non un file video. Dichiararlo `movie` lo farebbe
        // raggruppare fra i filmati del dispositivo.
        let attributes = CSSearchableItemAttributeSet(contentType: .content)
        attributes.title = snapshot.name
        attributes.displayName = snapshot.name
        attributes.contentDescription = Self.itemDescription(for: snapshot)
        attributes.keywords = snapshot.keywords
        attributes.thumbnailData = thumbnailData

        let item = CSSearchableItem(
            uniqueIdentifier: snapshot.id,
            domainIdentifier: domainIdentifier,
            attributeSet: attributes
        )
        item.expirationDate = Date().addingTimeInterval(expiration)
        return item
    }

    /// La riga sotto il nome: dati del titolo, poi la trama.
    ///
    /// PERCHE' UN SEPARATORE VISIBILE — `CSSearchableItemAttributeSet` non ha
    /// un campo "sottotitolo" distinto dalla descrizione: Spotlight disegna
    /// `contentDescription` su una riga sola e collassa gli a capo. Separando
    /// con `\n` sul device si leggeva "Film · 2026 · Thriller Gemma, una
    /// giovane madre…", cioe' generi e trama attaccati. Il separatore deve
    /// reggere anche da collassato.
    static func itemDescription(for snapshot: SpotlightTitleSnapshot) -> String {
        [snapshot.subtitle, snapshot.overview]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " — ")
    }

    // MARK: - Miniature

    /// Le miniature da mettere negli item, per id di snapshot.
    ///
    /// Due sorgenti, in quest'ordine: la cache su disco (`URLCache.shared`, la
    /// stessa che riempie `CachedAsyncImage`) per **tutti** gli snapshot, e la
    /// rete per i primi `thumbnailDownloadLimit` che non ce l'hanno. Prima si
    /// legge il disco perche' e' gratis e perche', dopo qualche giro, copre da
    /// solo quasi tutta la lista: `URLSession` deposita in quella stessa cache
    /// cio' che scarichiamo qui.
    private static func thumbnails(for snapshots: [SpotlightTitleSnapshot]) async -> [String: Data] {
        var thumbnails: [String: Data] = [:]
        var pending: [(id: String, url: URL)] = []

        for snapshot in snapshots {
            guard let posterURL = snapshot.posterURL else { continue }
            let small = thumbnailURL(for: posterURL)
            // La misura grande si accetta se e' gia' sul disco: e' sotto il
            // tetto di peso e risparmia una richiesta.
            if let data = cachedData(for: small) ?? cachedData(for: posterURL) {
                thumbnails[snapshot.id] = data
            } else if pending.count < thumbnailDownloadLimit {
                pending.append((snapshot.id, small))
            }
        }

        guard !pending.isEmpty else { return thumbnails }

        let deadline = Date().addingTimeInterval(thumbnailTotalBudget)
        await withTaskGroup(of: (String, Data?).self) { group in
            var next = 0
            let initial = min(thumbnailConcurrency, pending.count)
            while next < initial {
                let item = pending[next]
                next += 1
                group.addTask { (item.id, await downloadThumbnail(from: item.url)) }
            }

            for await (id, data) in group {
                if let data {
                    thumbnails[id] = data
                }
                // Scaduto il budget non si parte piu': quelle gia' in volo
                // finiscono da sole entro il timeout di richiesta, e i titoli
                // rimasti si indicizzano senza miniatura.
                guard next < pending.count, Date() < deadline else { continue }
                let item = pending[next]
                next += 1
                group.addTask { (item.id, await downloadThumbnail(from: item.url)) }
            }
        }

        return thumbnails
    }

    /// La stessa poster alla misura giusta per una miniatura.
    ///
    /// TMDB serve la misura nel percorso (`/t/p/w500/abc.jpg`): riscriverla
    /// costa niente e fa scendere l'immagine da ~60 KB a ~10. Un URL che non e'
    /// TMDB, o gia' piccolo, torna com'e' — mai una URL costruita a pezzi di
    /// stringa (docs/context/IOS_CODE_STYLE.md, networking).
    static func thumbnailURL(for url: URL) -> URL {
        guard url.host()?.lowercased() == "image.tmdb.org" else { return url }

        var segments = url.pathComponents.filter { $0 != "/" }
        guard segments.count >= 4, segments[0] == "t", segments[1] == "p" else { return url }

        let size = segments[2]
        // `original` non ha una larghezza da confrontare: si riduce sempre.
        if let width = Int(size.dropFirst()), size.hasPrefix("w"), width <= thumbnailWidth {
            return url
        }
        guard size == "original" || size.hasPrefix("w") else { return url }

        segments[2] = "w\(thumbnailWidth)"
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        components.path = "/" + segments.joined(separator: "/")
        return components.url ?? url
    }

    private static func cachedData(for url: URL) -> Data? {
        guard let cached = URLCache.shared.cachedResponse(for: URLRequest(url: url)) else { return nil }
        guard !cached.data.isEmpty, cached.data.count <= maxThumbnailBytes else { return nil }
        return cached.data
    }

    private static func downloadThumbnail(from url: URL) async -> Data? {
        do {
            let request = URLRequest(url: url, timeoutInterval: thumbnailRequestTimeout)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return nil
            }
            guard !data.isEmpty, data.count <= maxThumbnailBytes else { return nil }
            return data
        } catch {
            // Una miniatura in meno e' una riga senza copertina, non un errore
            // da mostrare: all'utente non arriva niente, a noi si' (§5).
            SilentFailure.record(error, context: "Spotlight.thumbnail")
            return nil
        }
    }
}

// MARK: - Servizio

/// Tiene allineato l'indice Spotlight ai titoli dell'utente **corrente**.
///
/// Registrato in `AppContainer`, chiamato da due parti sole:
/// - `WatchlistViewModel.load` per scrivere, sui dati che ha appena caricato;
/// - `SessionStore` / `AppContainer.signOutEverywhere` per svuotare.
@MainActor
final class SpotlightIndexer {

    /// Dominio unico di tutti gli item scritti dall'app.
    ///
    /// PERCHE' UNO SOLO — e' cio' che rende possibile `removeAll` con una
    /// chiamata sola, senza tenere da nessuna parte l'elenco degli id
    /// indicizzati. Al logout non si "prova a ricordare" cosa cancellare: si
    /// cancella il dominio.
    static let domainIdentifier = "com.paolocelestini.twowatch.ios.titles"

    private let writer: any SpotlightIndexWriting
    private let defaults: UserDefaults

    /// Cosa e' stato scritto **in questo processo**: evita di riscrivere
    /// duecento item ogni volta che la Watchlist ricompare. In memoria e basta,
    /// perche' `Hasher` e' seminato per processo e il valore non avrebbe senso
    /// al riavvio.
    private var lastIndexedFingerprint: Int?

    init(
        writer: any SpotlightIndexWriting = CoreSpotlightIndexWriter(),
        defaults: UserDefaults = .standard
    ) {
        self.writer = writer
        self.defaults = defaults
    }

    // MARK: Proprietario dell'indice

    /// Impronta dell'utente a cui appartiene l'indice attuale, persistita.
    ///
    /// PERCHE' PERSISTITA — l'indice di sistema sopravvive alla chiusura
    /// dell'app. Senza sapere di chi e', al riavvio l'unica scelta sicura
    /// sarebbe svuotarlo sempre, e i titoli tornerebbero cercabili solo dopo
    /// che l'utente ha riaperto la Watchlist. Sapendolo, l'indice resta valido
    /// fra un avvio e l'altro e si azzera **solo** quando cambia l'utente.
    ///
    /// PERCHE' UN HASH E NON L'UID — `UserDefaults` non e' il posto per un
    /// identificatore di persona (docs/context/IOS_CODE_STYLE.md §3.5). Per
    /// rispondere a "e' lo stesso di prima?" un digest basta.
    private var indexOwner: String? {
        get { defaults.string(forKey: SomtoDefaultsKey.spotlightIndexOwner) }
        set {
            guard let newValue else {
                defaults.removeObject(forKey: SomtoDefaultsKey.spotlightIndexOwner)
                return
            }
            defaults.set(newValue, forKey: SomtoDefaultsKey.spotlightIndexOwner)
        }
    }

    static func ownerFingerprint(for userID: String) -> String {
        SHA256.hash(data: Data(userID.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    // MARK: Scrittura

    /// Indicizza i titoli dell'utente corrente.
    ///
    /// Non rilancia: Spotlight e' accessorio, un fallimento non deve arrivare a
    /// schermo. Va pero' registrato, che e' diverso dal tacere (§5).
    func index(snapshots: [SpotlightTitleSnapshot], userID: String) async {
        let trimmedUserID = userID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUserID.isEmpty else { return }

        let owner = Self.ownerFingerprint(for: trimmedUserID)
        var hasher = Hasher()
        hasher.combine(owner)
        hasher.combine(snapshots)
        let fingerprint = hasher.finalize()
        guard fingerprint != lastIndexedFingerprint else { return }

        // Fra la cancellazione e la riscrittura il contenuto dell'indice non e'
        // noto: il proprietario si riscrive solo a operazione riuscita, cosi'
        // un fallimento a meta' lascia lo stato "di nessuno" e il prossimo
        // cambio account cancella comunque.
        indexOwner = nil
        lastIndexedFingerprint = nil

        do {
            try await writer.replaceAll(with: snapshots, domainIdentifier: Self.domainIdentifier)
            indexOwner = owner
            lastIndexedFingerprint = fingerprint
        } catch {
            SilentFailure.record(error, context: "Spotlight.index")
        }
    }

    // MARK: Privacy — cambio account e logout

    /// Da chiamare a ogni cambio di stato auth, logout compreso (`nil`).
    ///
    /// PERCHE' E' UN REQUISITO E NON UN DETTAGLIO — l'indice Spotlight vive nel
    /// sistema, non nell'app: senza questa chiamata i titoli di chi c'era prima
    /// resterebbero cercabili sul device di chi c'e' adesso, con tanto di
    /// poster, anche ad app chiusa. L'app ha gia' avuto un incidente al cambio
    /// account (limbo profilo, 2026-08-09); qui il difetto sarebbe peggio,
    /// perche' si vedrebbe da fuori dall'app.
    func handleAuthenticatedUserChange(to userID: String?) async {
        let fingerprint = userID
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .flatMap { $0.isEmpty ? nil : Self.ownerFingerprint(for: $0) }
        guard indexOwner != fingerprint else { return }
        await clear()
    }

    /// Svuota l'indice e dimentica di chi era.
    func clear() async {
        lastIndexedFingerprint = nil
        indexOwner = nil
        do {
            try await writer.removeAll(domainIdentifier: Self.domainIdentifier)
        } catch {
            SilentFailure.record(error, context: "Spotlight.clear")
        }
    }

    // MARK: Tap su un risultato

    /// Il doc id del titolo dietro un risultato Spotlight toccato, se
    /// l'activity e' davvero un tap Spotlight.
    ///
    /// `CSSearchableItemActionType` e' un tipo di `NSUserActivity` **diverso**
    /// da `NSUserActivityTypeBrowsingWeb` usato dai link universali: senza un
    /// handler dedicato in `TwoWatchApp`, il tap apre l'app e non fa niente.
    nonisolated static func titleID(from activity: NSUserActivity) -> String? {
        guard activity.activityType == CSSearchableItemActionType else { return nil }
        guard let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return nil }
        let trimmed = identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
