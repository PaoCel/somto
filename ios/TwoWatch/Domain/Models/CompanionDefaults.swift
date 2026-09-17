import Foundation

/// Un voto storico dell'utente, ridotto ai soli campi che servono per
/// calcolare i default del picker "Con chi l'hai visto?" (vedi
/// `CompanionDefaults`). Pure value type, niente Firebase: cosi' il calcolo
/// resta unit-testabile senza emulatore. Costruito da
/// `TitleRepository.fetchRecentRatingsForCompanionDefaults`.
struct CompanionRatingSample {
    let mediaType: MediaType
    /// Persone taggate su questo voto. Vuoto = "visto da solo".
    let companions: [FeedTaggedUser]
    let occurredAt: Date

}

/// Default calcolati per il picker "Con chi l'hai visto?": se preselezionare
/// la chip "Da solo" e quali compagni frequenti proporre come chip veloci,
/// invece di elencare tutti i seguiti.
struct CompanionDefaultsResult: Equatable {
    let preselectAlone: Bool
    let frequentCompanions: [FeedTaggedUser]

    static let empty = CompanionDefaultsResult(preselectAlone: false, frequentCompanions: [])
}

/// Calcola i default di "Con chi l'hai visto?" a partire dagli ultimi voti
/// dell'utente. Pure, senza Firebase: la lettura dei voti vive in
/// `TitleRepository.fetchRecentRatingsForCompanionDefaults`, la resa in UI in
/// `RatingPostComposerSheet`.
enum CompanionDefaults {
    /// Sotto questa soglia di campioni (per tipo film/serie, o in totale se
    /// quel tipo non ne ha abbastanza) i default restano vuoti: troppo pochi
    /// voti per essere un segnale affidabile. Parametro di tuning, derivato
    /// dal comportamento — non e' una soglia per singolo utente.
    static let minimumSampleCount = 5

    /// Quota di voti "senza compagni" sopra la quale la chip "Da solo" parte
    /// gia' selezionata. Parametro di tuning.
    static let aloneShareThreshold = 0.7

    /// Dimezzamento del peso di un voto ogni N giorni di eta': i compagni
    /// frequenti seguono le abitudini recenti senza ignorare del tutto la
    /// storia piu' vecchia. Parametro di tuning.
    static let recencyHalfLifeDays: Double = 30

    /// Quante chip di compagni frequenti proporre al massimo.
    static let maxFrequentCompanions = 3

    /// - Parameters:
    ///   - recentRatings: ultimi voti dell'utente (qualunque livello), in
    ///     un ordine qualunque.
    ///   - mediaType: tipo del titolo che si sta votando ora (film/serie).
    ///     Se ci sono abbastanza campioni di quel tipo si usano solo quelli,
    ///     altrimenti tutti i campioni insieme.
    static func compute(
        recentRatings: [CompanionRatingSample],
        mediaType: MediaType,
        now: Date = Date()
    ) -> CompanionDefaultsResult {
        let typeSamples = recentRatings.filter { $0.mediaType == mediaType }
        let samples = typeSamples.count >= minimumSampleCount ? typeSamples : recentRatings
        guard samples.count >= minimumSampleCount else { return .empty }

        let aloneCount = samples.filter { $0.companions.isEmpty }.count
        let aloneShare = Double(aloneCount) / Double(samples.count)
        let preselectAlone = aloneShare >= aloneShareThreshold

        var weightByUID: [String: Double] = [:]
        var nameByUID: [String: String] = [:]
        for sample in samples {
            let ageDays = max(0, now.timeIntervalSince(sample.occurredAt) / 86400)
            let weight = pow(0.5, ageDays / recencyHalfLifeDays)
            for companion in sample.companions {
                weightByUID[companion.id, default: 0] += weight
                nameByUID[companion.id] = companion.displayName
            }
        }

        let frequentCompanions = weightByUID.keys
            .sorted { lhs, rhs in
                let lhsWeight = weightByUID[lhs] ?? 0
                let rhsWeight = weightByUID[rhs] ?? 0
                if lhsWeight != rhsWeight { return lhsWeight > rhsWeight }
                return lhs < rhs // tiebreak deterministico
            }
            .prefix(maxFrequentCompanions)
            .map { FeedTaggedUser(id: $0, displayName: nameByUID[$0] ?? "") }

        return CompanionDefaultsResult(preselectAlone: preselectAlone, frequentCompanions: Array(frequentCompanions))
    }
}
