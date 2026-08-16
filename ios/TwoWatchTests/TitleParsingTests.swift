import XCTest
@testable import Somto

/// Test sul parsing dei payload Firestore/TMDB.
///
/// Queste funzioni erano `private` dentro `TitleRepository`, cioe' dentro una
/// classe che parla con Firestore: non erano richiamabili da un test. Eppure
/// sono il punto in cui un campo rinominato lato backend diventa un `nil`
/// silenzioso invece di un errore.
final class TitleParsingTests: XCTestCase {

    // MARK: - Chiave di deduplicazione

    /// `makeDedupeKey` e `parseDedupeKey` sono l'una l'inversa dell'altra: se
    /// divergono, i titoli si duplicano in catalogo.
    func testDedupeKeyRoundTrip() {
        let key = TitleParsing.makeDedupeKey(name: "Dune: Parte Due", type: .movie, year: 2024)
        let parsed = TitleParsing.parseDedupeKey(key)

        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.type, .movie)
        XCTAssertEqual(parsed?.year, 2024)
        XCTAssertEqual(parsed?.nameLower, SearchNormalizer.normalize("Dune: Parte Due"))
    }

    func testDedupeKeyRoundTripWithoutYear() {
        let key = TitleParsing.makeDedupeKey(name: "The Bear", type: .tv, year: nil)
        let parsed = TitleParsing.parseDedupeKey(key)

        XCTAssertEqual(parsed?.type, .tv)
        XCTAssertNil(parsed?.year)
    }

    /// I titoli col trattino basso nel nome sono il caso che rompe un parser
    /// naif: la chiave usa `_` come separatore, quindi il nome va ricomposto
    /// da tutte le parti tranne le ultime due.
    func testDedupeKeyHandlesUnderscoresInsideTheName() {
        let key = TitleParsing.makeDedupeKey(name: "Mission_Impossible", type: .movie, year: 1996)
        let parsed = TitleParsing.parseDedupeKey(key)

        XCTAssertEqual(parsed?.year, 1996)
        XCTAssertEqual(parsed?.type, .movie)
        XCTAssertFalse(parsed?.nameLower.isEmpty ?? true)
    }

    /// Le chiavi legacy portavano un suffisso `_tmdb_<id>`: vanno ancora lette,
    /// se no i titoli vecchi si sdoppiano.
    func testDedupeKeyStripsLegacyTMDBSuffix() {
        let parsed = TitleParsing.parseDedupeKey("dune_movie_2024_tmdb_693134")

        XCTAssertEqual(parsed?.type, .movie)
        XCTAssertEqual(parsed?.year, 2024)
    }

    func testDedupeKeyRejectsGarbage() {
        XCTAssertNil(TitleParsing.parseDedupeKey(""))
        XCTAssertNil(TitleParsing.parseDedupeKey("   "))
        XCTAssertNil(TitleParsing.parseDedupeKey("solo_due"))
    }

    // MARK: - ID titolo canonico

    func testCanonicalTitleID() {
        XCTAssertEqual(TitleParsing.canonicalTitleID(tmdbId: 693134, mediaType: .movie), "tmdb_movie_693134")
        XCTAssertEqual(TitleParsing.canonicalTitleID(tmdbId: 136315, mediaType: .tv), "tmdb_tv_136315")
    }

    // MARK: - ID voto

    /// L'id voto e' deterministico: stessa tupla, stesso documento. Se cambiasse
    /// forma, ogni voto ne creerebbe uno nuovo invece di aggiornare il suo.
    func testRatingIDIsDeterministic() {
        let a = TitleParsing.makeRatingID(userID: "u1", titleID: "t1", level: "title", season: nil, episode: nil)
        let b = TitleParsing.makeRatingID(userID: "u1", titleID: "t1", level: "title", season: nil, episode: nil)

        XCTAssertEqual(a, b)
        XCTAssertEqual(a, "u1__t1__title__0__0")
    }

    func testRatingIDSeparatesLevels() {
        let title = TitleParsing.makeRatingID(userID: "u1", titleID: "t1", level: "title", season: nil, episode: nil)
        let season = TitleParsing.makeRatingID(userID: "u1", titleID: "t1", level: "season", season: 1, episode: nil)
        let episode = TitleParsing.makeRatingID(userID: "u1", titleID: "t1", level: "episode", season: 1, episode: 3)

        XCTAssertEqual(Set([title, season, episode]).count, 3)
    }

    /// I doc id Firestore non tollerano qualunque carattere: quelli fuori
    /// allowlist diventano `_`.
    func testRatingIDSanitizesUnsafeCharacters() {
        let id = TitleParsing.makeRatingID(userID: "u/1", titleID: "t#1", level: "title", season: nil, episode: nil)

        XCTAssertFalse(id.contains("/"))
        XCTAssertFalse(id.contains("#"))
    }

    // MARK: - Video YouTube

    func testYouTubeIDAcceptsExactlyElevenAllowedCharacters() {
        XCTAssertEqual(TitleParsing.validatedYouTubeVideoID("dQw4w9WgXcQ"), "dQw4w9WgXcQ")
        XCTAssertEqual(TitleParsing.validatedYouTubeVideoID("  dQw4w9WgXcQ  "), "dQw4w9WgXcQ")
        XCTAssertEqual(TitleParsing.validatedYouTubeVideoID("a_b-c_d-e_f"), "a_b-c_d-e_f")
    }

    func testYouTubeIDRejectsWrongLengthOrCharacters() {
        XCTAssertNil(TitleParsing.validatedYouTubeVideoID("troppo-corto"))
        XCTAssertNil(TitleParsing.validatedYouTubeVideoID("dQw4w9WgXc"))      // 10
        XCTAssertNil(TitleParsing.validatedYouTubeVideoID("dQw4w9WgXcQQ"))    // 12
        XCTAssertNil(TitleParsing.validatedYouTubeVideoID("dQw4w9WgXc!"))     // carattere non ammesso
        XCTAssertNil(TitleParsing.validatedYouTubeVideoID(""))
    }

    // MARK: - Date TMDB

    /// TMDB manda due formati: `yyyy-MM-dd` per le uscite, ISO8601 completo
    /// altrove. Entrambi devono passare.
    func testTMDBDateParsesBothFormats() {
        XCTAssertNotNil(TitleParsing.tmdbDate("2024-02-28"))
        XCTAssertNotNil(TitleParsing.tmdbDate("2024-02-28T10:30:00Z"))
    }

    func testTMDBDateRejectsEmptyAndMalformed() {
        XCTAssertNil(TitleParsing.tmdbDate(nil))
        XCTAssertNil(TitleParsing.tmdbDate(""))
        XCTAssertNil(TitleParsing.tmdbDate("non una data"))
    }

    /// La data va letta col calendario gregoriano e locale POSIX: senza, su un
    /// dispositivo con calendario islamico o giapponese il giorno slitta.
    ///
    /// NB SUL FUSO — `tmdbDate` NON fissa il timeZone, quindi interpreta
    /// "2024-02-28" come mezzanotte **locale**. La prima versione di questo
    /// test rileggeva la data in UTC e falliva con 27 invece di 28: era il test
    /// a sbagliare, non la funzione. Qui si verifica cio' che la funzione
    /// promette davvero — indipendenza dal CALENDARIO — rileggendo nello stesso
    /// fuso in cui ha scritto.
    ///
    /// La dipendenza dal fuso resta un comportamento reale: finche' la data si
    /// scrive e si legge in locale non si vede, ma un confronto con una
    /// soglia UTC slitterebbe di un giorno. Annotato in
    /// docs/IOS_REFACTOR_PLAN.md come voce aperta: cambiarlo sposterebbe le
    /// date d'uscita mostrate agli utenti a ovest di UTC, e non e' una cosa da
    /// infilare in un refactoring.
    func testTMDBDateIsCalendarIndependent() throws {
        let date = try XCTUnwrap(TitleParsing.tmdbDate("2024-02-28"))
        let calendar = Calendar(identifier: .gregorian)   // fuso corrente, come il parser
        let parts = calendar.dateComponents([.year, .month, .day], from: date)

        XCTAssertEqual(parts.year, 2024)
        XCTAssertEqual(parts.month, 2)
        XCTAssertEqual(parts.day, 28)
    }

    /// Il 29 febbraio di un anno bisestile deve restare tale: se il parser
    /// cadesse su un calendario non gregoriano, qui si romperebbe.
    func testTMDBDateHandlesLeapDay() throws {
        let date = try XCTUnwrap(TitleParsing.tmdbDate("2024-02-29"))
        let parts = Calendar(identifier: .gregorian).dateComponents([.month, .day], from: date)

        XCTAssertEqual(parts.month, 2)
        XCTAssertEqual(parts.day, 29)
    }

    /// DOCUMENTA il comportamento, non lo approva: `DateFormatter` fa
    /// **rotolare** le date impossibili invece di rifiutarle, quindi
    /// "2023-02-29" (2023 non e' bisestile) diventa il 1° marzo e non `nil`.
    ///
    /// Va bene finche' la sorgente e' TMDB, che manda date valide. Diventerebbe
    /// un problema se lo stesso parser venisse usato su input utente: li' una
    /// data inesistente passerebbe silenziosamente come un'altra data.
    func testTMDBDateRollsOverImpossibleDatesInsteadOfRejecting() throws {
        let date = try XCTUnwrap(
            TitleParsing.tmdbDate("2023-02-29"),
            "oggi il parser NON restituisce nil su una data inesistente"
        )
        let parts = Calendar(identifier: .gregorian).dateComponents([.month, .day], from: date)

        XCTAssertEqual(parts.month, 3)
        XCTAssertEqual(parts.day, 1, "il 29 febbraio 2023 rotola al 1° marzo")
    }

    // MARK: - Deduplicazione stringhe

    func testUniqueStringsDropsDuplicatesAndBlanks() {
        let result = TitleParsing.uniqueStrings(["Azione", "azione", "  ", "", "Commedia", "AZIONE"])

        XCTAssertEqual(result.count, 2, "le tre varianti di 'azione' contano una volta sola")
        XCTAssertEqual(result.first, "Azione", "si tiene la prima grafia incontrata")
    }

    func testUniqueStringsPreservesOrder() {
        XCTAssertEqual(
            TitleParsing.uniqueStrings(["Zulu", "Alfa", "Zulu", "Bravo"]),
            ["Zulu", "Alfa", "Bravo"]
        )
    }
}

/// Test sulla regola delle iniziali, che dopo l'unificazione del 2026-08-09
/// e' UNA per tutta l'app (e allineata al web).
final class SomtoInitialsTests: XCTestCase {

    func testTwoWordNameUsesFirstAndLastInitial() {
        XCTAssertEqual(SomtoInitials.from("Paolo Celestini"), "PC")
    }

    func testThreeWordNameSkipsTheMiddle() {
        XCTAssertEqual(SomtoInitials.from("Maria Chiara Rossi"), "MR")
    }

    /// Il caso che distingueva le due implementazioni conviventi: quella del
    /// web (adottata) prende la SECONDA lettera della stessa parola.
    func testSingleWordNameUsesItsSecondLetter() {
        XCTAssertEqual(SomtoInitials.from("Cher"), "CH")
        XCTAssertEqual(SomtoInitials.from("madonna"), "MA")
    }

    func testSingleCharacterName() {
        XCTAssertEqual(SomtoInitials.from("X"), "X", "niente seconda lettera da prendere")
    }

    func testSingleStyleTakesOnlyTheFirstLetter() {
        XCTAssertEqual(SomtoInitials.from("Paolo Celestini", style: .single), "P")
        XCTAssertEqual(SomtoInitials.from("Cher", style: .single), "C")
    }

    func testEmptyAndWhitespaceFallBack() {
        XCTAssertEqual(SomtoInitials.from(nil), "?")
        XCTAssertEqual(SomtoInitials.from(""), "?")
        XCTAssertEqual(SomtoInitials.from("   "), "?")
        XCTAssertEqual(SomtoInitials.from(nil, fallback: "S"), "S")
    }

    func testExtraWhitespaceIsIgnored() {
        XCTAssertEqual(SomtoInitials.from("  Paolo   Celestini  "), "PC")
    }

    /// I nomi non latini non devono rompere: si prende comunque il primo
    /// carattere di ciascuna parola.
    func testNonLatinNames() {
        XCTAssertEqual(SomtoInitials.from("김 민준").count, 2)
        XCTAssertFalse(SomtoInitials.from("Ana Índigo").isEmpty)
    }
}
