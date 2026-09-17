import Foundation

// Voti personaggi ("Chi ti ha conquistato?") — spec docs/CHARACTER_VOTES_SPEC.md.
// Solo pick POSITIVI verso personaggi immaginari, mai un voto su una persona
// reale. Contratto pubblico consumato dalla UI (Features/): nomi e firme di
// questi tipi e dei metodi `TitleRepository` corrispondenti sono fissati,
// non vanno cambiati senza coordinarsi con chi scrive le view.

/// Un pick di personaggio scelto dall'utente per un episodio/titolo (spec
/// §2.1). Fino a 3 per doc `characterVotes/{id}`. `reaction`, se presente, è
/// una delle 12 chiavi `TitleEmotion` esistenti — stessa whitelist, mai una
/// copia: la validazione lato client la riusa via `TitleEmotion(rawValue:)`.
struct CharacterPick: Codable, Hashable {
    let personId: String
    let character: String?
    let reaction: String?
}

/// Un personaggio selezionabile nel picker "Chi ti ha conquistato?". Le guest
/// star di un episodio (`isGuest == true`) sono il motivo per cui la feature
/// esiste e vanno mostrate per prime; il cast fisso (titolo o episodio) segue,
/// ordinato per `order` (billing TMDB, o l'ordine di `castWithCharacters` in
/// fallback).
struct CharacterCandidate: Identifiable, Hashable {
    var id: String { personId }
    let personId: String
    let name: String
    let character: String?
    let profileURL: URL?
    let order: Int
    let isGuest: Bool
}

/// Bucket community grezzo: conteggio pick per personId + quanti utenti hanno
/// votato in questo bucket. Percentuale mostrabile = counts[id] / totalUsers
/// (spec §2.2/§2.3) — con max 3 pick per utente la somma delle percentuali
/// può superare il 100%, è corretto e va segnalato in UI.
struct CharacterVoteBucket: Hashable {
    let counts: [String: Int]
    let totalUsers: Int

    static let empty = CharacterVoteBucket(counts: [:], totalUsers: 0)

    /// personId ordinati per popolarità decrescente (tie-break personId
    /// crescente), solo count > 0. Mirror di `TitleEmotionAggregate.rankedEmotions`.
    var rankedCounts: [(personId: String, count: Int)] {
        counts.compactMap { key, count -> (personId: String, count: Int)? in
            guard count > 0 else { return nil }
            return (key, count)
        }
        .sorted { lhs, rhs in
            lhs.count != rhs.count ? lhs.count > rhs.count : lhs.personId < rhs.personId
        }
    }

    static func fromMap(_ map: [String: Any]) -> CharacterVoteBucket {
        var counts: [String: Int] = [:]
        for (key, value) in FirestoreValueReader.map(map["counts"]) {
            guard let intValue = FirestoreValueReader.int(value), intValue > 0 else { continue }
            counts[key] = intValue
        }
        let totalUsers = max(0, FirestoreValueReader.int(map, key: "totalUsers") ?? 0)
        return CharacterVoteBucket(counts: counts, totalUsers: totalUsers)
    }
}

/// Grado di apprezzamento di un personaggio dai pick della community.
///
/// Solo positivo e mai comparativo verso il basso: si votano personaggi, mai
/// le persone reali, e non esistono downvote (docs/CHARACTER_VOTES_SPEC.md).
/// Specchio esatto di `characterAppreciation` in
/// `public/js/api/characterVotes.api.js`: stesse soglie, stesso campione
/// minimo, altrimenti le due piattaforme direbbero cose diverse sullo stesso
/// personaggio.
enum CharacterAppreciation: String {
    case top
    case high
    case some

    /// Sotto questo numero di votanti non mostriamo nessuna etichetta:
    /// "Amato" da un voto solo è rumore, e su una scheda titolo sembra un dato.
    static let minimumUsers = 5

    /// La quota è su UTENTI unici che hanno scelto quel personaggio; con tre
    /// pick a testa la somma di tutte le quote può superare il 100%. È
    /// corretto: non è una ripartizione.
    static func from(bucket: CharacterVoteBucket?, personID: String) -> CharacterAppreciation? {
        guard let bucket, bucket.totalUsers >= minimumUsers else { return nil }
        let count = bucket.counts[personID] ?? 0
        guard count > 0 else { return nil }

        let share = Double(count) / Double(bucket.totalUsers)
        if share >= 0.5 { return .top }
        if share >= 0.25 { return .high }
        if share >= 0.1 { return .some }
        return nil
    }

    var label: String {
        switch self {
        case .top: return String(localized: "Il più amato")
        case .high: return String(localized: "Molto amato")
        case .some: return String(localized: "Amato")
        }
    }
}

/// Aggregato community serie/stagione a UTENTI UNICI (non voti) —
/// `titles/{id}/aggregates/characters`, spec §2.3. `direct` = pick diretti a
/// livello titolo (level == "title"), separati dai pick derivati dagli
/// episodi in `series`/`bySeason`.
struct TitleCharacterAggregate: Hashable {
    let series: CharacterVoteBucket
    let bySeason: [String: CharacterVoteBucket]
    let direct: CharacterVoteBucket

    static func fromMap(_ map: [String: Any]) -> TitleCharacterAggregate? {
        guard !map.isEmpty else { return nil }
        let series = CharacterVoteBucket.fromMap(FirestoreValueReader.map(map["series"]))
        let direct = CharacterVoteBucket.fromMap(FirestoreValueReader.map(map["direct"]))

        var bySeason: [String: CharacterVoteBucket] = [:]
        for (key, value) in FirestoreValueReader.map(map["bySeason"]) {
            guard let seasonNumber = Int(key), seasonNumber > 0 else { continue }
            bySeason[String(seasonNumber)] = CharacterVoteBucket.fromMap(FirestoreValueReader.map(value))
        }

        guard series.totalUsers > 0 || direct.totalUsers > 0 || !bySeason.isEmpty else { return nil }
        return TitleCharacterAggregate(series: series, bySeason: bySeason, direct: direct)
    }

    /// Bucket da usare per parlare del titolo nel suo insieme: i pick derivati
    /// dagli episodi se ci sono, altrimenti quelli diretti. Specchio di
    /// `pickCommunityBucket` sul web — non si sommano, sarebbe doppio conteggio
    /// degli utenti che hanno fatto entrambi.
    var communityBucket: CharacterVoteBucket? {
        if series.totalUsers > 0 { return series }
        if direct.totalUsers > 0 { return direct }
        return nil
    }
}

/// Rollup personale privato — `users/{uid}/characterPicks/{titleId}`, spec
/// §2.4. `topPersonId`/`topCharacter`/`topCount` = il personaggio che
/// l'utente ha scelto più spesso per questo titolo (nil/0 se non ha ancora
/// votato nulla). Owner-read, server-write only: mai scritto dal client.
struct MyCharacterPicks: Hashable {
    let series: [String: Int]
    let bySeason: [String: [String: Int]]
    let topPersonId: String?
    let topCharacter: String?
    let topCount: Int

    static func fromMap(_ map: [String: Any]) -> MyCharacterPicks? {
        guard !map.isEmpty else { return nil }

        var series: [String: Int] = [:]
        for (key, value) in FirestoreValueReader.map(map["series"]) {
            guard let intValue = FirestoreValueReader.int(value), intValue > 0 else { continue }
            series[key] = intValue
        }

        var bySeason: [String: [String: Int]] = [:]
        for (seasonKey, seasonValue) in FirestoreValueReader.map(map["bySeason"]) {
            guard let seasonNumber = Int(seasonKey), seasonNumber > 0 else { continue }
            var seasonCounts: [String: Int] = [:]
            for (personId, count) in FirestoreValueReader.map(seasonValue) {
                guard let intValue = FirestoreValueReader.int(count), intValue > 0 else { continue }
                seasonCounts[personId] = intValue
            }
            bySeason[String(seasonNumber)] = seasonCounts
        }

        let top = FirestoreValueReader.map(map["top"])
        let topPersonId = FirestoreValueReader.string(top, key: "personId")
        let topCharacter = FirestoreValueReader.string(top, key: "character")
        let topCount = FirestoreValueReader.int(top, key: "count") ?? 0

        guard !series.isEmpty || !bySeason.isEmpty || topPersonId != nil else { return nil }
        return MyCharacterPicks(
            series: series,
            bySeason: bySeason,
            topPersonId: topPersonId,
            topCharacter: topCharacter,
            topCount: topCount
        )
    }
}
