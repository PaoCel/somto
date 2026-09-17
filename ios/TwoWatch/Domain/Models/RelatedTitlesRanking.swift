import Foundation

/// Voce di `users/{uid}/tasteProfile/agg.featureSums.<bucket>.<id>`: quanto
/// l'utente ama/odia un genere o una persona, come somma pesata delle sue
/// azioni (voti, watchlist, completamenti — vedi `docs/context/TASTE_ENGINE.md`).
struct TasteFeatureEntry: Hashable, Sendable {
    let sum: Double
    let weight: Double
}

/// `featureSums` del profilo gusti dell'utente, ridotto ai due bucket che
/// contano per i correlati (generi e persone). Bucket mancanti o profilo
/// assente equivalgono a nessuna affinità nota.
struct TasteFeatureSums: Hashable, Sendable {
    var genres: [String: TasteFeatureEntry] = [:]
    var people: [String: TasteFeatureEntry] = [:]
}

/// Ordinamento "Titoli correlati" della scheda titolo — modulo puro, nessuna
/// fetch, nessun Firestore. Mirror esatto di `public/js/utils/relatedRanking.js`
/// (stessa formula, stessi pesi, stesso tie-break): iOS e web devono produrre
/// lo stesso ordine a parità di dati, altrimenti "correlati" significa una
/// cosa diversa a seconda della piattaforma da cui l'utente apre la scheda.
///
/// Il chiamante (`TitleRepository.fetchRelatedTitles`) fa tutte le letture e
/// passa qui solo dati già in memoria: titoli candidati, punteggio
/// collaborativo (`titles/{id}/aggregates/similar`) e il tasteProfile
/// dell'utente, quando disponibile.
enum RelatedTitlesRanking {
    private static let ratingCountWeight = 0.35
    private static let collabScoreWeight = 2.0
    private static let tasteGenreWeight = 1.0
    private static let tastePeopleWeight = 0.6
    private static let tastePeopleSample = 8

    /// Affinità gusti personali di un titolo, da -1 (evitato) a un valore
    /// positivo aperto (più generi/persone amate ci sono, più sale). `nil`
    /// (nessun tasteProfile) equivale a 0.
    static func tasteAffinity(for title: Title, featureSums: TasteFeatureSums?) -> Double {
        guard let featureSums else { return 0 }
        var score = 0.0

        var seenGenres = Set<String>()
        for genre in title.genres {
            let key = genre.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty, seenGenres.insert(key).inserted else { continue }
            score += featureAffinity(featureSums.genres, id: key) * tasteGenreWeight
        }

        var seenPeople = Set<String>()
        for personID in title.castIDs.prefix(tastePeopleSample) {
            let key = personID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty, seenPeople.insert(key).inserted else { continue }
            score += featureAffinity(featureSums.people, id: key) * tastePeopleWeight
        }

        return score
    }

    /// Titoli ordinati: curati prima (nell'ordine dato), poi il resto per
    /// punteggio = 2x affinità collaborativa + affinità gusti + un piccolo
    /// termine di popolarità (log del numero di voti). Dedup per id, prima
    /// occorrenza vince; `excludeIDs` (titolo pagina, membri saga già
    /// mostrati altrove) non compaiono mai.
    static func rank(
        curatedIDs: [String],
        candidates: [Title],
        similarityByID: [String: Double] = [:],
        featureSums: TasteFeatureSums? = nil,
        excludeIDs: Set<String> = []
    ) -> [Title] {
        let curatedSet = Set(curatedIDs)

        // Doc id Firestore come chiave: permesso dal footgun dizionari (vedi
        // CLAUDE.md), non e' una chiave derivata. Prima occorrenza vince.
        var byID: [String: Title] = [:]
        var order: [String] = []
        for candidate in candidates {
            let id = candidate.id
            guard !id.isEmpty, !excludeIDs.contains(id), byID[id] == nil else { continue }
            byID[id] = candidate
            order.append(id)
        }

        let curated = curatedIDs.filter { byID[$0] != nil }
        let curatedIDSet = Set(curated)

        let rest = order
            .filter { !curatedIDSet.contains($0) }
            .compactMap { id -> (title: Title, score: Double)? in
                guard let title = byID[id] else { return nil }
                let simScore = similarityByID[id] ?? 0
                let score = (simScore * collabScoreWeight)
                    + tasteAffinity(for: title, featureSums: featureSums)
                    + popularityTerm(for: title)
                return (title, score)
            }
            .sorted { lhs, rhs in
                if lhs.score != rhs.score { return lhs.score > rhs.score }
                return lhs.title.name.localizedStandardCompare(rhs.title.name) == .orderedAscending
            }
            .map(\.title)

        return curated.compactMap { byID[$0] } + rest
    }

    private static func featureAffinity(_ bucket: [String: TasteFeatureEntry], id: String) -> Double {
        guard let entry = bucket[id], entry.weight > 0 else { return 0 }
        return min(1, max(-1, entry.sum / (entry.weight + 1.2)))
    }

    private static func popularityTerm(for title: Title) -> Double {
        log10(1 + Double(max(0, title.ratingCount))) * ratingCountWeight
    }
}
