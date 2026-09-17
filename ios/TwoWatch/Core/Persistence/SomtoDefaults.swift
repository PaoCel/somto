import Foundation

// Registro unico delle chiavi `UserDefaults` dell'app.
//
// PERCHE' ESISTE — prima di questo file le chiavi nascevano dove serviva, e
// convivevano cinque convenzioni diverse: `somto.watchlistIntroSeen.v1`,
// `somto_watchtime_unit`, `titleDetailVNextTourVersion`,
// `recommendedUpdateDismissedBuild`, `twowatch_thread_reads` (con il nome del
// brand precedente). Nessuna era sbagliata da sola; tutte insieme volevano dire
// che non esisteva un posto dove sapere *cosa* l'app persiste sul device.
//
// Due conseguenze concrete, non estetiche:
//   1. una chiave scritta da una schermata e letta da un'altra con una grafia
//      diversa e' un bug che non si vede in review;
//   2. le chiavi dinamiche (una per import) crescono senza tetto, e
//      `UserDefaults` viene caricato **per intero** all'avvio.
//
// REGOLE (docs/context/IOS_CODE_STYLE.md §3):
//   - forma `somto.<area><Cosa>.v<N>`, versione sempre;
//   - niente chiavi che contengono un id — servono collezioni con un tetto;
//   - una chiave ha un solo proprietario, che la legge e la scrive.
enum SomtoDefaultsKey {

    // MARK: Home

    static let youngBannerDismissed = "somto.youngBannerDismissed.v1"
    /// Id degli import per cui il reveal di fine import e' gia' stato mostrato.
    /// Collezione con tetto (vedi `ImportRevealStore`), non una chiave per import.
    static let importRevealSeenIDs = "somto.importRevealSeenIDs.v1"

    // MARK: Watchlist

    /// Di chi e' il riassunto lasciato al widget. Persistente e non in memoria:
    /// tenuto in RAM, a ogni avvio dell'app risultava un cambio utente e il
    /// widget si svuotava da solo (constatato sul device il 2026-08-15).
    static let widgetSnapshotOwner = "somto.widgetSnapshotOwner.v1"

    static let watchlistIntroSeen = "somto.watchlistIntroSeen.v1"
    static let watchlistWelcomeDismissed = "somto.watchlistWelcomeDismissed.v1"
    static let watchlistCreateTipDismissed = "somto.watchlistCreateTipDismissed.v1"

    // MARK: Profilo

    /// Unita' di misura delle ore viste sulla card profilo (`WatchTimeUnitMode`).
    static let watchTimeUnit = "somto.watchTimeUnit.v1"

    // MARK: Scheda titolo

    /// Ultima versione del tour della scheda titolo gia' vista dall'utente.
    static let titleDetailTourVersion = "somto.titleDetailTourVersion.v1"

    // MARK: Match

    static let matchHintSeen = "somto.matchHintSeen.v1"

    // MARK: Notifiche push

    static let pushPromptSeen = "somto.pushPromptSeen.v1"
    static let pushBannerDismissedAt = "somto.pushBannerDismissedAt.v1"

    // MARK: Aggiornamento app

    /// Build consigliato per cui l'utente ha gia' premuto "Piu' tardi".
    static let recommendedUpdateDismissedBuild = "somto.recommendedUpdateDismissedBuild.v1"

    // MARK: Thread

    /// Mappa threadID -> timestamp dell'ultima lettura.
    static let threadReads = "somto.threadReads.v1"

    // MARK: Prompt recensione App Store

    static let ratingPromptLastDate = "somto.ratingPromptLastDate.v1"
    static let ratingPromptLastVersion = "somto.ratingPromptLastVersion.v1"
    static let ratingPromptPositiveVersion = "somto.ratingPromptPositiveVersion.v1"
    static let ratingPromptPositiveDate = "somto.ratingPromptPositiveDate.v1"
    static let ratingPromptQualifyingEvents = "somto.ratingPromptQualifyingEvents.v1"

    // MARK: Spotlight

    /// Impronta (SHA256) dell'utente a cui appartengono gli item scritti
    /// nell'indice di sistema. Non l'uid: serve solo a rispondere "e' lo stesso
    /// di prima?", e `UserDefaults` non e' il posto per un identificatore di
    /// persona (§3.5). Proprietario unico: `SpotlightIndexer`.
    static let spotlightIndexOwner = "somto.spotlightIndexOwner.v1"

    // MARK: Ricerca

    /// Prefisso completato dallo scope (`SearchScope.historyKey`). E' un
    /// namespace **limitato**: gli scope sono un enum, non dati dell'utente.
    static let searchHistoryPrefix = "somto.searchHistory.v1."
}

// MARK: - Migrazione

/// Porta le chiavi legacy sui nomi canonici **senza perdere il valore**.
///
/// PERCHE' NON BASTA RINOMINARE — le chiavi vivono sui device di utenti reali,
/// su un'app gia' pubblicata. Rinominare `twowatch_thread_reads` e basta
/// farebbe riapparire come non letti tutti i thread di tutti; rinominare
/// `titleDetailVNextTourVersion` rimetterebbe il tour davanti a chi lo ha gia'
/// chiuso.
///
/// PERCHE' COPIA E **NON** CANCELLA — su un device non si torna indietro. Se la
/// copia avesse un difetto e la legacy fosse gia' sparita, il dato dell'utente
/// sarebbe perso e nessuna release successiva potrebbe recuperarlo. Tenere il
/// vecchio valore costa qualche byte e rende la migrazione **reversibile**: una
/// build precedente installata sopra ritrova i suoi dati.
///
/// La pulizia delle chiavi legacy va fatta in una release **successiva**, quando
/// la coorte App Store e' passata: vedi `docs/PENDING.md`. Non farla qui.
///
/// Gira una volta sola per installazione (`migrationDone`), all'avvio, prima che
/// una qualsiasi View legga. Se in futuro si aggiungono rinomine, si incrementa
/// la versione della sentinella.
enum SomtoDefaultsMigration {

    private static let migrationDone = "somto.defaultsMigration.v1"

    /// Rinomine pure: stesso valore, stesso tipo, nome nuovo.
    private static let renames: [(legacy: String, canonical: String)] = [
        ("somto_watchtime_unit", SomtoDefaultsKey.watchTimeUnit),
        ("titleDetailVNextTourVersion", SomtoDefaultsKey.titleDetailTourVersion),
        ("recommendedUpdateDismissedBuild", SomtoDefaultsKey.recommendedUpdateDismissedBuild),
        ("twowatch_thread_reads", SomtoDefaultsKey.threadReads),
        ("somto.matchHintSeen", SomtoDefaultsKey.matchHintSeen),
        ("pushPromptSeenV1", SomtoDefaultsKey.pushPromptSeen),
        ("wlWelcomeDismissed", SomtoDefaultsKey.watchlistWelcomeDismissed),
        ("wlCreateTipDismissed", SomtoDefaultsKey.watchlistCreateTipDismissed),
        ("rating_prompt_last_date", SomtoDefaultsKey.ratingPromptLastDate),
        ("rating_prompt_last_version", SomtoDefaultsKey.ratingPromptLastVersion),
        ("rating_prompt_positive_version", SomtoDefaultsKey.ratingPromptPositiveVersion),
        ("rating_prompt_positive_date", SomtoDefaultsKey.ratingPromptPositiveDate),
        ("rating_prompt_qualifying_events", SomtoDefaultsKey.ratingPromptQualifyingEvents)
    ]

    private static let legacyImportRevealPrefix = "home_import_reveal_seen_"
    private static let legacySearchHistoryPrefix = "search.history.v1."

    static func run(on defaults: UserDefaults = .standard) {
        guard !defaults.bool(forKey: migrationDone) else { return }

        for rename in renames {
            copy(from: rename.legacy, to: rename.canonical, in: defaults)
        }
        collapseImportRevealKeys(in: defaults)
        copyPrefixedKeys(
            from: legacySearchHistoryPrefix,
            to: SomtoDefaultsKey.searchHistoryPrefix,
            in: defaults
        )

        defaults.set(true, forKey: migrationDone)
    }

    /// Copia solo se la destinazione e' ancora vuota: se l'utente ha gia'
    /// scritto sulla chiave nuova (build mista, rollback), il valore recente
    /// vince. La legacy **resta**: la migrazione dev'essere reversibile finche'
    /// la coorte non e' passata.
    ///
    /// L'idempotenza la garantisce la sentinella `migrationDone`, non la
    /// cancellazione.
    private static func copy(from legacy: String, to canonical: String, in defaults: UserDefaults) {
        guard let value = defaults.object(forKey: legacy),
              defaults.object(forKey: canonical) == nil
        else { return }
        defaults.set(value, forKey: canonical)
    }

    /// `home_import_reveal_seen_<importID>` -> una sola lista con tetto.
    /// Erano N chiavi che non venivano cancellate mai: una in piu' a ogni import.
    ///
    /// Anche qui le legacy restano: non crescono piu' (nessuno ci scrive), e
    /// cancellarle subito renderebbe la migrazione irreversibile per guadagnare
    /// qualche byte.
    private static func collapseImportRevealKeys(in defaults: UserDefaults) {
        let legacyKeys = defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(legacyImportRevealPrefix) }
        guard !legacyKeys.isEmpty else { return }

        let seenIDs = legacyKeys
            .filter { defaults.bool(forKey: $0) }
            .map { String($0.dropFirst(legacyImportRevealPrefix.count)) }

        if !seenIDs.isEmpty, defaults.object(forKey: SomtoDefaultsKey.importRevealSeenIDs) == nil {
            defaults.set(
                Array(seenIDs.prefix(ImportRevealStore.limit)),
                forKey: SomtoDefaultsKey.importRevealSeenIDs
            )
        }
    }

    /// Copia in blocco un namespace a prefisso, conservando i suffissi.
    private static func copyPrefixedKeys(
        from legacyPrefix: String,
        to canonicalPrefix: String,
        in defaults: UserDefaults
    ) {
        let legacyKeys = defaults.dictionaryRepresentation().keys
            .filter { $0.hasPrefix(legacyPrefix) }
        for key in legacyKeys {
            copy(
                from: key,
                to: canonicalPrefix + key.dropFirst(legacyPrefix.count),
                in: defaults
            )
        }
    }
}
