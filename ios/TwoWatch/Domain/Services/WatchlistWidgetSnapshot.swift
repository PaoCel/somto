import Foundation
import WidgetKit

// Il ponte fra l'app e il widget "Watchlist".
//
// PERCHE' UN FILE E NON UNA LETTURA — il widget delle prossime uscite legge un
// endpoint pubblico, e per quello basta `URLSession` (vedi
// `UpcomingReleasesFeed.swift`). La watchlist invece e' roba dell'utente, e in
// un'estensione non c'e' modo di chiederla: `Bundle.main` e' il `.appex` quindi
// `FirebaseBootstrap` va in `fatalError`, il keychain non e' condiviso quindi
// `Auth.currentUser` non esiste, e `FirebaseFirestore` trascina gRPC/BoringSSL,
// cioe' la dipendenza che da sola domina il budget di memoria di un widget.
//
// Quindi non e' il widget che va a prendere i dati: e' l'app che glieli lascia.
// Quando la Watchlist finisce di caricare, scrive qui un riassunto dentro un
// App Group; il widget lo legge e disegna. Costo: zero letture Firestore, zero
// rete, nessuna migrazione del keychain. Prezzo: la freschezza e' quella
// dell'ultima apertura dell'app — accettabile per un elenco che cambia quando
// sei tu a segnare un episodio.
//
// COSA NON DEVE ENTRARE QUI — niente uid, niente email, niente id di documenti
// personali: solo cio' che si vede a schermo. Il file vive nel container
// condiviso e ci resta finche' l'app non lo cancella (vedi `clear()`, chiamata
// al logout).

// MARK: - Modello

/// Il riassunto della watchlist che il widget disegna.
///
/// I testi NON sono precalcolati: si salvano i numeri (stagione, episodio,
/// visti su totale) e la frase la compone il widget. Cosi' se cambi la lingua
/// del telefono il widget cambia con lei, invece di restare nella lingua che
/// aveva l'app l'ultima volta che e' stata aperta.
struct WatchlistWidgetSnapshot: Codable, Sendable, Hashable {
    struct Row: Codable, Sendable, Hashable, Identifiable {
        /// Se e' una serie che stai guardando o un titolo ancora da iniziare.
        enum Kind: String, Codable, Sendable {
            case inProgress = "in_progress"
            case upNext = "up_next"
        }

        /// Doc id del titolo: e' anche la chiave del deep link.
        let id: String
        let name: String
        let isSeries: Bool
        let kind: Kind
        let season: Int?
        let episode: Int?
        let episodesWatched: Int?
        let episodesTotal: Int?
        /// Quanto della serie hai gia' visto, 0-1. Serve alla barra: un numero
        /// di episodi non dice a colpo d'occhio se sei a meta' o alla fine.
        let percentComplete: Double?
        /// Durata di un episodio, in minuti. NON e' "quanto ti manca": Somto
        /// sa quale episodio hai visto, non a che minuto sei dentro quello dopo.
        let episodeMinutes: Int?
        /// La piattaforma su cui si vede, quando la sappiamo: nome e logo.
        let providerName: String?
        let providerLogoUrl: URL?
        /// Il link che porta a guardarlo.
        ///
        /// Quando esiste un deep link diretto al titolo dentro l'app della
        /// piattaforma va qui, e il tasto play ci porta. Oggi nessuna delle
        /// nostre fonti lo da' (TMDB espone nome e logo, non l'id del titolo
        /// dentro Netflix), quindi resta `nil` e il widget ripiega sulla ricerca
        /// nell'app della piattaforma — vedi `WidgetWatchLink`. Il campo esiste
        /// gia' perche' il giorno che una fonte arriva (JustWatch, Amazon
        /// Associates, iTunes Search) si riempie qui e basta.
        let watchUrl: URL?
        /// L'id TMDB: serve solo a costruire il ripiego "dove guardare" quando
        /// la piattaforma non e' fra quelle che sappiamo aprire da sole.
        let tmdbId: Int?
        let posterUrl: URL?
        /// Percorso in-app, non URL completo: la forma `/share/title/<docId>` e'
        /// l'unica che funziona senza slug (`nativeDestination(path:)` mappa
        /// `/film|/serie/<slug>` su una query per slug, che con un doc id non
        /// trova niente e muore in silenzio).
        let path: String
    }

    /// Il client controlla la versione prima di fidarsi della forma. Un widget
    /// che legge un file piu' nuovo di quello che sa leggere mostra lo stato
    /// vuoto invece di disegnare campi a caso.
    static let currentVersion = 1

    let version: Int
    let updatedAt: Date
    let rows: [Row]

    init(rows: [Row], updatedAt: Date = Date(), version: Int = WatchlistWidgetSnapshot.currentVersion) {
        self.version = version
        self.updatedAt = updatedAt
        self.rows = rows
    }
}

// MARK: - Quante righe, e di che tipo

/// Come si dividono le righe fra "in corso" e "da guardare".
///
/// La domanda che porta qui e' "dove ero rimasto": le serie in corso vengono
/// prima e si prendono la maggioranza. La coda entra come coda — una riga, due
/// nella misura grande — perche' serve a rispondere alla seconda domanda
/// ("e dopo?") senza trasformare il widget in un elenco senza fuoco.
enum WatchlistWidgetRowPlan {
    static func upNextQuota(rowCount: Int) -> Int {
        switch rowCount {
        case ..<3: return 0
        case 3: return 1
        default: return 2
        }
    }

    /// Le righe da disegnare: prima le serie in corso, poi la coda fino alla sua
    /// quota. Se una delle due non basta a riempire, l'altra si allarga: meglio
    /// un widget pieno di una sola cosa che un widget mezzo vuoto.
    static func rows(from all: [WatchlistWidgetSnapshot.Row], rowCount: Int) -> [WatchlistWidgetSnapshot.Row] {
        guard rowCount > 0 else { return [] }
        let inProgress = all.filter { $0.kind == .inProgress }
        let upNext = all.filter { $0.kind == .upNext }
        let quota = min(upNextQuota(rowCount: rowCount), upNext.count)
        let chosenInProgress = inProgress.prefix(max(0, rowCount - quota))
        let chosenUpNext = upNext.prefix(rowCount - chosenInProgress.count)
        return Array(chosenInProgress) + Array(chosenUpNext)
    }
}

// MARK: - Lettura e scrittura

enum WatchlistWidgetSnapshotStore {
    /// L'App Group condiviso fra app ed estensione. Va dichiarato negli
    /// entitlement di ENTRAMBI i target: se manca da uno,
    /// `containerURL(forSecurityApplicationGroupIdentifier:)` torna `nil` e qui
    /// non si scrive (e non si legge) niente — in silenzio, senza crash.
    static let appGroup = "group.com.paolocelestini.twowatch.ios"

    /// I `kind` dei due widget che leggono da qui, per svegliarli dopo una
    /// scrittura: l'elenco e quello con il bottone su una serie sola.
    static let widgetKind = "SomtoWatchlist"
    static let episodeWidgetKind = "SomtoEpisodeCheck"

    private static let fileName = "watchlist-widget.json"

    private static var fileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(fileName)
    }

    static func read() -> WatchlistWidgetSnapshot? {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let snapshot = try? decoder.decode(WatchlistWidgetSnapshot.self, from: data) else { return nil }
        guard snapshot.version == WatchlistWidgetSnapshot.currentVersion else { return nil }
        return snapshot
    }

    /// Scrive e sveglia il widget. Se la scrittura fallisce non c'e' niente da
    /// dire all'utente: il widget continua a mostrare il riassunto precedente,
    /// che e' esattamente cio' che si vuole.
    static func write(_ snapshot: WatchlistWidgetSnapshot) {
        guard let fileURL else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return }
        // `.completeFileProtectionUnlessOpen`: il widget si aggiorna anche a
        // telefono bloccato, e con la protezione piena il file sarebbe
        // illeggibile proprio allora.
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        // Il riassunto nuovo e' la verita': i marcatori "appena segnato" del
        // widget hanno finito il loro lavoro.
        WatchlistWidgetPendingStore.clear()
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        WidgetCenter.shared.reloadTimelines(ofKind: episodeWidgetKind)
    }

    /// Aggiorna il progresso di UNA serie, con i numeri che ha risposto il
    /// server dopo un tap sul bottone del widget.
    ///
    /// PERCHE' NON BASTA ASPETTARE L'APP — fra il tap e la prossima apertura di
    /// Somto possono passare ore. Senza questo, il widget continuerebbe a dire
    /// "Sei a S3·E7" dopo che hai segnato l'ottavo: sembrerebbe non aver fatto
    /// niente, ed e' esattamente cosa porta a toccare il bottone due volte.
    static func applyProgress(
        titleId: String,
        episodesWatched: Int?,
        season: Int?,
        episode: Int?
    ) {
        guard let current = read() else { return }
        let rows = current.rows.map { row -> WatchlistWidgetSnapshot.Row in
            guard row.id == titleId else { return row }
            return WatchlistWidgetSnapshot.Row(
                id: row.id,
                name: row.name,
                isSeries: row.isSeries,
                // Una serie che era "da guardare" ora e' iniziata.
                kind: .inProgress,
                season: season ?? row.season,
                episode: episode ?? row.episode,
                episodesWatched: episodesWatched ?? row.episodesWatched,
                episodesTotal: row.episodesTotal,
                percentComplete: Self.percent(watched: episodesWatched ?? row.episodesWatched, total: row.episodesTotal)
                    ?? row.percentComplete,
                episodeMinutes: row.episodeMinutes,
                providerName: row.providerName,
                providerLogoUrl: row.providerLogoUrl,
                watchUrl: row.watchUrl,
                tmdbId: row.tmdbId,
                posterUrl: row.posterUrl,
                path: row.path
            )
        }
        write(WatchlistWidgetSnapshot(rows: rows, updatedAt: current.updatedAt))
    }

    /// La barra si muove insieme al numero: dopo un tap sul bottone il
    /// progresso e' cambiato davvero, e lasciarla ferma sarebbe la stessa bugia
    /// di lasciare fermo l'episodio.
    private static func percent(watched: Int?, total: Int?) -> Double? {
        guard let watched, let total, total > 0 else { return nil }
        return max(0, min(1, Double(watched) / Double(total)))
    }

    /// Al logout il riassunto va via: e' l'unico posto dove dei dati personali
    /// sopravvivono fuori dal sandbox dell'app, e chi entra dopo sullo stesso
    /// telefono non deve vedere la watchlist di prima.
    static func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
        WatchlistWidgetPendingStore.clear()
        WidgetCenter.shared.reloadTimelines(ofKind: widgetKind)
        WidgetCenter.shared.reloadTimelines(ofKind: episodeWidgetKind)
    }
}

// MARK: - La serie scelta col tap

/// Quale serie sta in testa al widget grande.
///
/// PERCHE' UN FILE E NON LA CONFIGURAZIONE — cambiare serie da "Modifica widget"
/// e' una strada che non trova nessuno (constatato: "non avevo idea di come si
/// potesse cambiare"). Con le miniature in fondo al widget il cambio e' un tap,
/// e questo file e' dove quel tap lascia il segno. La configurazione resta e
/// vale come preferenza iniziale: appena si tocca una miniatura, comanda questa.
enum WatchlistWidgetSelectionStore {
    private static let fileName = "watchlist-widget-selection.json"

    private static var fileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: WatchlistWidgetSnapshotStore.appGroup)?
            .appendingPathComponent(fileName)
    }

    static func read() -> String? {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return nil }
        return (try? JSONDecoder().decode([String: String].self, from: data))?["titleId"]
    }

    static func set(_ titleId: String) {
        guard let fileURL, let data = try? JSONEncoder().encode(["titleId": titleId]) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
    }

    static func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }
}

// MARK: - Cosa ho appena segnato dal widget

/// Lo stato dell'ultimo tap su "episodio visto", per titolo.
///
/// PERCHE' ESISTE — due motivi, e nessuno dei due e' estetico.
///
/// `inFlight` impedisce il DOPPIO CONTEGGIO: un tap fa una richiesta di rete, e
/// chi non vede succedere niente tocca di nuovo (feedback dal device: "uno fa
/// doppio tap, triplo tap"). Il secondo tap entro la finestra non parte, invece
/// di segnare un episodio che non hai visto.
///
/// `failed` e' l'unica voce che il widget puo' dare quando la richiesta non
/// riesce: li' non c'e' schermata dove mostrare un errore.
///
/// Il successo NON sta qui: quando la callable risponde si aggiorna il
/// riassunto vero con i numeri che torna il server, cosi' il widget mostra il
/// punto NUOVO ("Sei a S3·E8") e il bottone resta pronto per l'episodio dopo.
/// Una conferma tipo "aggiornato" sarebbe rumore: che sia aggiornato lo dice il
/// numero cambiato.
struct WatchlistWidgetPendingEntry: Codable, Sendable, Hashable {
    enum State: String, Codable, Sendable {
        case inFlight
        case failed
    }

    let state: State
    let at: Date
}

enum WatchlistWidgetPendingStore {
    /// Quanto dura la guardia contro il secondo tap. Larga quanto il timeout
    /// della richiesta: oltre, o e' arrivata o e' fallita.
    static let inFlightWindow: TimeInterval = 20

    private static let fileName = "watchlist-widget-pending.json"

    private static var fileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: WatchlistWidgetSnapshotStore.appGroup)?
            .appendingPathComponent(fileName)
    }

    static func read() -> [String: WatchlistWidgetPendingEntry] {
        guard let fileURL, let data = try? Data(contentsOf: fileURL) else { return [:] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([String: WatchlistWidgetPendingEntry].self, from: data)) ?? [:]
    }

    /// C'e' gia' un tap in volo per questo titolo?
    static func isInFlight(_ titleId: String, now: Date = Date()) -> Bool {
        guard let entry = read()[titleId], entry.state == .inFlight else { return false }
        return now.timeIntervalSince(entry.at) < inFlightWindow
    }

    static func set(_ state: WatchlistWidgetPendingEntry.State, for titleId: String, now: Date = Date()) {
        write { $0[titleId] = WatchlistWidgetPendingEntry(state: state, at: now) }
    }

    static func remove(_ titleId: String) {
        write { $0[titleId] = nil }
    }

    /// Si svuota quando arriva un riassunto nuovo: da quel momento il file dice
    /// gia' la verita', e un marcatore in piu' sarebbe una bugia sopra un dato
    /// giusto.
    static func clear() {
        guard let fileURL else { return }
        try? FileManager.default.removeItem(at: fileURL)
    }

    private static func write(_ mutate: (inout [String: WatchlistWidgetPendingEntry]) -> Void) {
        guard let fileURL else { return }
        var all = read()
        mutate(&all)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(all) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
    }
}
