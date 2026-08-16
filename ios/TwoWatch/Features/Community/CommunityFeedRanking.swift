import Foundation

/// Ranking del feed Community (specchio della logica del web live). Il feed
/// mescola:
/// - gli **eventi di chi segui** (grafo follow, sempre freschissimi), e
/// - **tutti i post pubblici** (popolarità × recency),
/// così anche un utente con zero follow vede contenuti.
///
/// Funzioni pure e deterministiche → facilmente testabili, nessun side effect.
enum CommunityFeedRanking {
    /// Un candidato del feed con il suo punteggio e la sorgente.
    struct Ranked: Identifiable {
        enum Source {
            case follow
            case publicPost
            case comment
        }

        let activity: FeedActivity
        let score: Double
        let source: Source

        var id: String { activity.id }
    }

    /// Bonus base che gli eventi del grafo follow ricevono anche quando sono un
    /// post (per non farli mai finire sotto un post pubblico a parità di età).
    static let followBasePostBonus: Double = 0.5

    /// Massimo numero di candidati per sorgente e nel feed finale.
    static let candidateCap = 40

    /// Punteggio di un post pubblico: popolarità (like + 2×commenti) smorzata
    /// dall'età con decadimento super-lineare.
    static func scorePublicPost(likes: Int, comments: Int, ageHours: Double) -> Double {
        let popularity = 1.0 + Double(likes) + 2.0 * Double(comments)
        return popularity / pow(max(0, ageHours) + 2.0, 1.5)
    }

    /// Punteggio di un evento del grafo follow: peso costante alto, decadimento
    /// più lento (chi segui conta di più, più a lungo).
    static func scoreFollowEvent(ageHours: Double) -> Double {
        6.0 / pow(max(0, ageHours) + 2.0, 1.2)
    }

    /// Ore trascorse da `date` rispetto a `now`. `nil` → molto vecchio.
    static func ageHours(since date: Date?, now: Date = Date()) -> Double {
        guard let date else { return 1_000_000 }
        return max(0, now.timeIntervalSince(date) / 3600)
    }

    /// Mescola gli eventi del grafo follow e i post pubblici in un unico feed
    /// ordinato. Deduplica per `postId` (l'evento follow vince, così un tuo
    /// amico che posta non appare due volte), ordina per punteggio desc e taglia
    /// a `candidateCap`.
    /// Punteggio di un commento (post-eco di un thread pubblico). Due
    /// differenze rispetto ai post: decadimento molto più lento (^0.5) — un
    /// commento su una serie che stai guardando resta interessante anche se
    /// vecchio, ed è ciò che rende visibile lo storico senza falsificare le
    /// date — e bonus forte se il titolo è nella tua libreria (segnale di
    /// pertinenza, ed è il caso in cui il gate anti-spoiler resta aperto).
    /// Stessi numeri del web (`scoreCommentItem` in community.page.js).
    static let commentBase: Double = 3
    static let commentLibraryBonus: Double = 5
    /// Quanti commenti al massimo entrano in una build del feed: senza tetto,
    /// una serie molto commentata riempirebbe tutto.
    static let commentItemsCap = 8

    static func scoreComment(ageHours: Double, inLibrary: Bool) -> Double {
        let base = commentBase + (inLibrary ? commentLibraryBonus : 0)
        return base / pow(max(0, ageHours) + 2.0, 0.5)
    }

    /// Un commento pronto per il ranking.
    struct ScoredComment {
        let activity: FeedActivity
        let inLibrary: Bool
    }

    static func blendRankedFeed(
        followEvents: [FeedActivity],
        publicPosts: [ScoredPublicPost],
        comments: [ScoredComment] = [],
        now: Date = Date()
    ) -> [FeedActivity] {
        var followRanked: [Ranked] = []
        var seenPostIDs: Set<String> = []

        for event in followEvents.prefix(candidateCap) {
            let age = ageHours(since: event.createdAt, now: now)
            var score = scoreFollowEvent(ageHours: age)
            if event.kind == .post || event.kind == .postShare {
                score += followBasePostBonus
            }
            followRanked.append(Ranked(activity: event, score: score, source: .follow))
            if let postID = event.postId, !postID.isEmpty {
                seenPostIDs.insert(postID)
            }
        }

        var publicRanked: [Ranked] = []
        for scored in publicPosts.prefix(candidateCap) {
            // Un post pubblico già presente nel grafo follow non viene duplicato.
            if seenPostIDs.contains(scored.activity.id) { continue }
            if let postID = scored.activity.postId, !postID.isEmpty, seenPostIDs.contains(postID) { continue }
            let age = ageHours(since: scored.activity.createdAt, now: now)
            let score = scorePublicPost(
                likes: scored.likes,
                comments: scored.comments,
                ageHours: age
            )
            publicRanked.append(Ranked(activity: scored.activity, score: score, source: .publicPost))
        }

        // I commenti entrano per ultimi e con un tetto proprio: dedupe contro
        // le altre sorgenti (lo stesso eco può arrivare da più query) e cap ai
        // migliori.
        var commentRanked: [Ranked] = []
        var seenCommentIDs: Set<String> = []
        for scored in comments {
            let id = scored.activity.id
            if seenPostIDs.contains(id) || seenCommentIDs.contains(id) { continue }
            seenCommentIDs.insert(id)
            let age = ageHours(since: scored.activity.createdAt, now: now)
            commentRanked.append(Ranked(
                activity: scored.activity,
                score: scoreComment(ageHours: age, inLibrary: scored.inLibrary),
                source: .comment
            ))
        }
        commentRanked = Array(commentRanked.sorted { $0.score > $1.score }.prefix(commentItemsCap))

        let blended = (followRanked + publicRanked + commentRanked)
            .sorted { $0.score > $1.score }
            .prefix(candidateCap)

        return blended.map(\.activity)
    }

    /// Un post pubblico pronto per il ranking: la sua rappresentazione feed +
    /// i contatori social usati per la popolarità.
    struct ScoredPublicPost {
        let activity: FeedActivity
        let likes: Int
        let comments: Int
    }
}

/// Ranking di "Discussioni per te".
///
/// Riscritto: prima il modulo pescava dai 40 thread pubblici più recenti e,
/// **se nessuno era rilevante, ripiegava sui più recenti** pur di non restare
/// vuoto. Risultato: in cima alla Community comparivano discussioni su serie
/// che l'utente non aveva mai visto né aggiunto, senza spiegazione. Ora la
/// regola è secca: **si suggerisce solo ciò che è agganciato alla libreria
/// dell'utente**, ogni riga porta con sé il motivo, e se non c'è niente di
/// pertinente il modulo mostra un empty state utile invece di riempirsi.
///
/// Funzioni pure e deterministiche → testabili, nessun side effect.
enum CommunityDiscussionsRanking {
    /// Perché questa discussione è stata suggerita. È anche il criterio di
    /// ordinamento: l'ordine dei case è l'ordine di priorità.
    enum Reason: Hashable {
        /// Discussione dell'episodio esatto appena segnato come visto.
        case justWatchedEpisode(season: Int, episode: Int)
        /// Serie/film finito da poco (o in attesa di voto).
        case recentlySeen
        /// Serie che l'utente sta guardando adesso.
        case watching
        /// Ultimo messaggio scritto da una persona che l'utente segue.
        case followedPerson(name: String)

        /// Testo mostrato nella card. Prima persona, nessun gergo.
        var label: String {
            switch self {
            case .justWatchedEpisode(let season, let episode):
                return "Hai appena visto S\(season)E\(episode)"
            case .recentlySeen:
                return String(localized: "L'hai visto da poco")
            case .watching:
                return String(localized: "Stai guardando questa serie")
            case .followedPerson(let name):
                return "\(name) ha commentato"
            }
        }

        var symbolName: String {
            switch self {
            case .justWatchedEpisode: return "checkmark.circle.fill"
            case .recentlySeen: return "eye.fill"
            case .watching: return "play.circle.fill"
            case .followedPerson: return "person.fill"
            }
        }

        /// Peso base: decide quale motivo vince quando più d'uno si applica.
        var weight: Int {
            switch self {
            case .justWatchedEpisode: return 100
            case .recentlySeen: return 60
            case .watching: return 50
            case .followedPerson: return 40
            }
        }
    }

    /// Aggancio di un titolo alla libreria dell'utente: è ciò che rende un
    /// thread suggeribile. Un titolo senza segnale non entra mai.
    struct LibrarySignal: Equatable {
        enum Kind: Equatable {
            case watching
            case recentlySeen
        }

        let kind: Kind
        /// Ultimo episodio visto, quando noto: serve a riconoscere il thread
        /// dell'episodio *esatto* appena guardato.
        let lastWatched: EpisodeCoordinates?
        /// Quando l'utente ha toccato per l'ultima volta questo titolo.
        let touchedAt: Date?
    }

    struct EpisodeCoordinates: Equatable {
        let season: Int
        let episode: Int
    }

    /// Una discussione suggerita, con il suo motivo.
    struct Suggestion: Identifiable, Equatable {
        let thread: AppThread
        let reason: Reason
        let score: Int

        var id: String { thread.id }

        static func == (lhs: Suggestion, rhs: Suggestion) -> Bool {
            lhs.thread.id == rhs.thread.id && lhs.reason == rhs.reason && lhs.score == rhs.score
        }
    }

    /// Pochi suggerimenti, ben scelti. Il brief chiede 2–3: oltre quella soglia
    /// la sezione tornava a essere una lista dispersiva.
    /// Una riga sola: da quando i commenti compaiono come card nel feed, la
    /// sezione è un promemoria, non il contenuto principale (stesso valore del
    /// web, `COMMUNITY_THREADS_MAX`).
    static let cap = 1

    /// Un solo thread per titolo: due discussioni della stessa serie in cima
    /// alla Community sono ridondanti (e dopo l'import dei commenti TV Time una
    /// serie può avere decine di thread-episodio).
    static let perTitleCap = 1

    /// Oltre questa finestra un episodio non è più "appena visto".
    static let justWatchedWindowDays = 10

    /// Costruisce i suggerimenti.
    ///
    /// - Parameters:
    ///   - threads: candidati (thread pubblici, di qualsiasi età).
    ///   - signals: aggancio libreria per titleId.
    ///   - followedUserIDs: persone seguite che sono state attive di recente;
    ///     usate solo per il motivo "X ha commentato", mai per far entrare un
    ///     titolo estraneo alla libreria.
    ///   - followedUserNames: id → nome, per il testo del motivo.
    static func buildSuggestions(
        threads: [AppThread],
        signals: [String: LibrarySignal],
        followedUserIDs: Set<String> = [],
        followedUserNames: [String: String] = [:],
        now: Date = Date()
    ) -> [Suggestion] {
        guard !signals.isEmpty else { return [] }

        var scored: [Suggestion] = []
        for thread in threads {
            // Niente anteprima = niente da mostrare: la card sarebbe muta.
            guard !thread.lastMessagePreview.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            // Solo discussioni pubbliche legate a un titolo.
            guard thread.isPublic, let titleID = thread.titleId, !titleID.isEmpty else { continue }
            // **Il filtro che prima mancava**: se il titolo non è agganciato
            // alla libreria dell'utente, non lo si suggerisce. Punto.
            guard let signal = signals[titleID] else { continue }

            let reason = resolveReason(
                thread: thread,
                signal: signal,
                followedUserIDs: followedUserIDs,
                followedUserNames: followedUserNames,
                now: now
            )
            scored.append(
                Suggestion(
                    thread: thread,
                    reason: reason,
                    score: reason.weight + activityBonus(thread: thread, now: now)
                )
            )
        }

        let ordered = scored.sorted { lhs, rhs in
            if lhs.score != rhs.score { return lhs.score > rhs.score }
            let lDate = lhs.thread.lastMessageAt ?? .distantPast
            let rDate = rhs.thread.lastMessageAt ?? .distantPast
            return lDate > rDate
        }

        var perTitle: [String: Int] = [:]
        var result: [Suggestion] = []
        for suggestion in ordered {
            let key = suggestion.thread.titleId ?? suggestion.thread.id
            let seen = perTitle[key, default: 0]
            if seen >= perTitleCap { continue }
            perTitle[key] = seen + 1
            result.append(suggestion)
            if result.count >= cap { break }
        }
        return result
    }

    /// Il motivo più forte fra quelli applicabili.
    private static func resolveReason(
        thread: AppThread,
        signal: LibrarySignal,
        followedUserIDs: Set<String>,
        followedUserNames: [String: String],
        now: Date
    ) -> Reason {
        // 1. Discussione dell'episodio esatto appena visto.
        if case .episode(let season, let episode) = thread.scope,
           let lastWatched = signal.lastWatched,
           lastWatched.season == season,
           lastWatched.episode == episode,
           isRecent(signal.touchedAt, withinDays: justWatchedWindowDays, now: now) {
            return .justWatchedEpisode(season: season, episode: episode)
        }

        // 2. Una persona seguita ha scritto l'ultimo messaggio: motivo più
        //    "sociale" del generico stato libreria, ma solo su titoli già
        //    rilevanti (il guard sopra lo garantisce).
        if let senderID = thread.lastSenderUid,
           followedUserIDs.contains(senderID),
           let name = followedUserNames[senderID], !name.isEmpty {
            return .followedPerson(name: name)
        }

        // 3. Stato della libreria.
        switch signal.kind {
        case .recentlySeen: return .recentlySeen
        case .watching: return .watching
        }
    }

    /// Piccolo bonus per le discussioni vive: non ribalta mai la priorità del
    /// motivo (max +9 contro salti da 10 punti fra i motivi), fa solo da
    /// spareggio fra thread con lo stesso motivo.
    static func activityBonus(thread: AppThread, now: Date = Date()) -> Int {
        guard let last = thread.lastMessageAt else { return 0 }
        let days = now.timeIntervalSince(last) / 86_400
        switch days {
        case ..<2: return 9
        case ..<7: return 6
        case ..<30: return 3
        default: return 0
        }
    }

    private static func isRecent(_ date: Date?, withinDays days: Int, now: Date) -> Bool {
        guard let date else { return false }
        return now.timeIntervalSince(date) <= Double(days) * 86_400
    }

    /// Estrae gli agganci alla libreria dalla dashboard watchlist, che la
    /// Community carica già per altri motivi (nessuna query aggiuntiva).
    static func buildSignals(
        inProgress: [TitlePersonalState],
        recentlySeen: [TitlePersonalState],
        cap: Int = 60
    ) -> [String: LibrarySignal] {
        var signals: [String: LibrarySignal] = [:]

        // "Sta guardando" per primo, poi "visto di recente" può sovrascrivere:
        // una serie appena finita è un segnale più forte di una in corso.
        for state in inProgress.prefix(cap) {
            signals[state.titleId] = LibrarySignal(
                kind: .watching,
                lastWatched: episodeCoordinates(from: state),
                touchedAt: state.seriesProgress?.lastWatchedAt ?? state.lastInteractionAt ?? state.updatedAt
            )
        }

        for state in recentlySeen.prefix(cap) {
            signals[state.titleId] = LibrarySignal(
                kind: .recentlySeen,
                lastWatched: episodeCoordinates(from: state),
                touchedAt: state.completedAt ?? state.seenAt ?? state.lastInteractionAt ?? state.updatedAt
            )
        }

        return signals
    }

    private static func episodeCoordinates(from state: TitlePersonalState) -> EpisodeCoordinates? {
        guard let progress = state.seriesProgress,
              let season = progress.lastWatchedSeasonNumber,
              let episode = progress.lastWatchedEpisodeNumber,
              season > 0, episode > 0
        else { return nil }
        return EpisodeCoordinates(season: season, episode: episode)
    }
}

extension AppPost {
    /// Converte un post pubblico in un `FeedActivity` renderizzabile dal
    /// `FeedActivityCard` (kind `.post`). L'id del feed è l'id del post così la
    /// deduplica per `postId` funziona.
    func asPublicFeedActivity() -> FeedActivity {
        FeedActivity(
            id: id,
            kind: .post,
            actor: author,
            relatedUser: nil,
            title: title,
            titleId: titleId,
            postId: id,
            recommendationId: nil,
            sourceId: id,
            sourcePath: "posts/\(id)",
            rating: rating,
            previousRating: nil,
            level: "title",
            season: nil,
            episode: nil,
            text: text,
            snippet: nil,
            reviewText: reviewText,
            taggedTitles: taggedTitles,
            mediaURL: mediaURL,
            mediaURLs: mediaURLs,
            watchedWith: watchedWith,
            watchedWithGroup: watchedWithGroup,
            sharedPost: sharedPost,
            createdAt: createdAt,
            webURL: URL(string: "https://somto.it/?post=\(id)")
        )
    }
}
